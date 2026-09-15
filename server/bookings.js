import { randomUUID } from 'node:crypto';

import {
    EVENTS,
    getEvent,
    getWorkshop,
    isEventUpcoming,
    MAKERSPACE_SUBACCOUNT_CODE,
    PAYMENT_CURRENCY,
    WORKSHOP,
    WORKSHOPS,
} from './config.js';
import { AppError } from './errors.js';
import { initializePaystackTransaction, requirePaystackKeys } from './paystack.js';
import { getSupabaseClient } from './supabase.js';

export function validateBooking(input = {}, now = Date.now()) {
    const eventSlug = String(input.eventSlug || '');
    const event = getEvent(eventSlug);
    const quantity = Number(input.quantity ?? 1);
    const name = String(input.name || '').trim();
    const email = String(input.email || '').trim().toLowerCase();

    if (!event) return { error: 'Choose a valid event.' };
    if (!isEventUpcoming(event, now)) return { error: 'That session has already started. Please choose another.' };
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > event.capacity) {
        return { error: event.capacity === 1 ? 'This session accepts one booking.' : `Choose between 1 and ${event.capacity} bookings.` };
    }
    if (name.length < 2 || name.length > 100) return { error: 'Enter your name.' };
    if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { error: 'Enter a valid email address.' };
    }

    return {
        eventSlug,
        classSlug: event.classSlug,
        date: event.date,
        period: event.period,
        quantity,
        name,
        email,
    };
}

export function validateBookingCancellation(input = {}) {
    const bookingId = String(input.bookingId || '').trim();
    const reference = String(input.reference || '').trim();

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bookingId)) {
        return { error: 'The reservation ID is invalid.' };
    }
    if (!/^[A-Za-z0-9.=-]{1,120}$/.test(reference)) {
        return { error: 'The payment reference is invalid.' };
    }

    return { bookingId, reference };
}

function createReference(bookingId) {
    const suffix = bookingId.replaceAll('-', '').slice(0, 12);
    return `mksp-${Date.now().toString(36)}-${suffix}`;
}

export async function getAvailability(env = process.env, supabase = getSupabaseClient(env), now = Date.now()) {
    const { data, error } = await supabase
        .from('makerspace_bookings')
        .select('event_slug,quantity,status,expires_at')
        .in('status', ['reserved', 'paid']);

    if (error) {
        throw new AppError('Availability is temporarily unavailable.', 503, 'storage_unavailable');
    }

    const reservedByEvent = new Map();
    for (const booking of data || []) {
        if (booking.status === 'reserved' && Date.parse(booking.expires_at) <= now) continue;
        if (!booking.event_slug) continue;
        reservedByEvent.set(
            booking.event_slug,
            (reservedByEvent.get(booking.event_slug) || 0) + Number(booking.quantity),
        );
    }

    const events = EVENTS.filter((event) => isEventUpcoming(event, now)).map((event) => {
        const reserved = reservedByEvent.get(event.slug) || 0;
        return {
            ...event,
            title: getWorkshop(event.classSlug).name,
            currency: PAYMENT_CURRENCY,
            reserved,
            remaining: Math.max(0, event.capacity - reserved),
        };
    });

    return { workshop: WORKSHOP, workshops: WORKSHOPS, events };
}

export async function createBooking(input, env = process.env, supabase = getSupabaseClient(env)) {
    const booking = validateBooking(input);
    if (booking.error) throw new AppError(booking.error, 400, 'invalid_booking');

    const event = getEvent(booking.eventSlug);
    const paystack = requirePaystackKeys(env);
    const bookingId = randomUUID();
    const paymentId = randomUUID();
    const reference = createReference(bookingId);
    const amount = event.amount * booking.quantity;

    const { data, error } = await supabase.rpc('reserve_makerspace_booking', {
        p_booking_id: bookingId,
        p_payment_id: paymentId,
        p_reference: reference,
        p_class_slug: booking.classSlug,
        p_session_date: booking.date,
        p_session_period: booking.period,
        p_customer_name: booking.name,
        p_customer_email: booking.email,
        p_quantity: booking.quantity,
        p_environment: paystack.environment,
        p_event_slug: booking.eventSlug,
        p_capacity: event.capacity,
        p_subaccount_code: MAKERSPACE_SUBACCOUNT_CODE,
        p_amount: amount,
        p_currency: PAYMENT_CURRENCY,
    });

    if (error) {
        throw new AppError('We could not prepare the payment record. Please try again.', 503, 'storage_unavailable');
    }
    if (!data?.ok) {
        if (data?.reason === 'session_full') {
            throw new AppError('That session has just been booked. Please choose another.', 409, 'session_full');
        }
        throw new AppError('We could not reserve that session. Please try again.', 409, data?.reason || 'reservation_failed');
    }

    try {
        const checkout = await initializePaystackTransaction({
            email: booking.email,
            amount,
            currency: PAYMENT_CURRENCY,
            reference,
            metadata: {
                booking_id: bookingId,
                event_slug: booking.eventSlug,
                workshop_slug: booking.classSlug,
                session_date: booking.date,
                session_period: booking.period,
                quantity: booking.quantity,
                custom_fields: [
                    { display_name: 'Workshop', variable_name: 'workshop', value: getWorkshop(booking.classSlug).name },
                    { display_name: 'Event', variable_name: 'event', value: booking.eventSlug },
                    { display_name: 'Session', variable_name: 'session', value: `${booking.date} · ${booking.period}` },
                    { display_name: 'Booking ID', variable_name: 'booking_id', value: bookingId },
                ],
            },
        }, env);

        return {
            bookingId,
            reference,
            checkout: {
                ...checkout,
                amount,
                currency: PAYMENT_CURRENCY,
            },
        };
    } catch (error) {
        try {
            await cancelBooking({ bookingId, reference }, env, supabase);
        } catch {
            // The database hold expires automatically if immediate cleanup is unavailable.
        }
        throw error;
    }
}

export async function cancelBooking(input, env = process.env, supabase = getSupabaseClient(env)) {
    const cancellation = validateBookingCancellation(input);
    if (cancellation.error) {
        throw new AppError(cancellation.error, 400, 'invalid_cancellation');
    }

    const { data, error } = await supabase.rpc('cancel_makerspace_booking', {
        p_booking_id: cancellation.bookingId,
        p_reference: cancellation.reference,
    });

    if (error) {
        throw new AppError('We could not release that reservation. Please try again.', 503, 'storage_unavailable');
    }
    if (!data?.ok) {
        if (data?.reason === 'not_found') {
            throw new AppError('We could not find that reservation.', 404, 'reservation_not_found');
        }
        if (data?.reason === 'already_paid') {
            throw new AppError('That booking has already been paid.', 409, 'booking_already_paid');
        }
        throw new AppError('That reservation can no longer be cancelled.', 409, data?.reason || 'cancellation_failed');
    }

    return {
        cancelled: true,
        alreadyCancelled: Boolean(data.already_cancelled),
    };
}
