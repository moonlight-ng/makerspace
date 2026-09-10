import { getWorkshop } from './config.js';
import { AppError } from './errors.js';
import { getSupabaseClient } from './supabase.js';

export const STUDIO_ORDER_STATES = Object.freeze([
    'all',
    'paid',
    'pending',
    'expired',
    'failed',
    'cancelled',
]);
export const STUDIO_ORDER_ENVIRONMENTS = Object.freeze(['all', 'live', 'test']);

function boundedInteger(value, fallback, minimum, maximum) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new AppError('The order query is invalid.', 400, 'invalid_order_query');
    }
    return number;
}

function selectedValue(value, allowed, fallback = 'all') {
    const selected = String(value || fallback).trim().toLowerCase();
    if (!allowed.includes(selected)) {
        throw new AppError('The order query is invalid.', 400, 'invalid_order_query');
    }
    return selected;
}

export function validateStudioOrderQuery(input = {}) {
    const query = String(input.q || '').trim();
    if (query.length > 120) {
        throw new AppError('Search terms must be 120 characters or fewer.', 400, 'invalid_order_query');
    }

    return {
        query: query || null,
        status: selectedValue(input.status, STUDIO_ORDER_STATES),
        environment: selectedValue(input.environment, STUDIO_ORDER_ENVIRONMENTS),
        limit: boundedInteger(input.limit, 30, 1, 100),
        offset: boundedInteger(input.offset, 0, 0, 100_000),
    };
}

export function deriveStudioOrderState(booking, payment, now = Date.now()) {
    if (payment?.status === 'success' || booking?.status === 'paid') return 'paid';
    if (booking?.status === 'cancelled') return 'cancelled';
    if (booking?.status === 'reserved' && Date.parse(booking.expires_at) <= now) return 'expired';
    if (payment?.status === 'failed') return 'failed';
    return 'pending';
}

export function paystackDashboardUrl(providerTransactionId) {
    const base = 'https://dashboard.paystack.com/#/transactions';
    const transactionId = String(providerTransactionId || '').trim();
    return transactionId ? `${base}/${encodeURIComponent(transactionId)}` : base;
}

function studioOrder(row) {
    const classSlug = row.class_slug;
    const workshop = getWorkshop(classSlug);
    return {
        id: row.booking_id,
        customerName: row.customer_name,
        customerEmail: row.customer_email,
        classSlug,
        workshop: workshop?.name || classSlug,
        eventSlug: row.event_slug,
        sessionDate: row.session_date,
        sessionPeriod: row.session_period,
        quantity: Number(row.quantity || 1),
        amount: Number(row.amount || 0),
        currency: row.currency,
        state: row.order_state,
        bookingStatus: row.booking_status,
        paymentStatus: row.payment_status,
        providerStatus: row.provider_status,
        providerTransactionId: row.provider_transaction_id,
        provider: row.provider,
        environment: row.environment,
        reference: row.reference,
        createdAt: row.booking_created_at,
        paymentCreatedAt: row.payment_created_at,
        expiresAt: row.expires_at,
        paidAt: row.paid_at,
        verifiedAt: row.verified_at,
        paystackDashboardUrl: paystackDashboardUrl(row.provider_transaction_id),
    };
}

function paymentForBooking(booking) {
    return Array.isArray(booking.makerspace_payments)
        ? booking.makerspace_payments[0]
        : booking.makerspace_payments;
}

function studioOrderFromBooking(booking, now = Date.now()) {
    const payment = paymentForBooking(booking) || {};
    return studioOrder({
        booking_id: booking.id,
        customer_name: booking.customer_name,
        customer_email: booking.customer_email,
        class_slug: booking.class_slug,
        event_slug: booking.event_slug,
        session_date: booking.session_date,
        session_period: booking.session_period,
        quantity: booking.quantity,
        booking_status: booking.status,
        booking_created_at: booking.created_at,
        expires_at: booking.expires_at,
        payment_status: payment.status,
        payment_created_at: payment.created_at,
        provider_status: payment.provider_status,
        provider_transaction_id: payment.provider_transaction_id,
        provider: payment.provider,
        environment: payment.environment,
        reference: payment.reference,
        amount: payment.amount,
        currency: payment.currency,
        paid_at: payment.paid_at,
        verified_at: payment.verified_at,
        order_state: deriveStudioOrderState(booking, payment, now),
    });
}

export async function listStudioOrders(
    input,
    env = process.env,
    supabase = getSupabaseClient(env),
) {
    const query = validateStudioOrderQuery(input);
    const { data, error } = await supabase.rpc('list_makerspace_studio_orders', {
        p_query: query.query,
        p_status: query.status,
        p_environment: query.environment,
        p_limit: query.limit,
        p_offset: query.offset,
    });

    if (error) {
        throw new AppError('Studio orders are temporarily unavailable.', 503, 'storage_unavailable');
    }

    const rows = Array.isArray(data?.orders) ? data.orders : [];
    const total = Number(data?.total || 0);
    return {
        orders: rows.map(studioOrder),
        total,
        hasMore: query.offset + rows.length < total,
    };
}

export async function getStudioOrder(
    bookingId,
    env = process.env,
    supabase = getSupabaseClient(env),
) {
    const id = String(bookingId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        throw new AppError('The order ID is invalid.', 400, 'invalid_order_id');
    }

    const { data, error } = await supabase
        .from('makerspace_bookings')
        .select(`
            id,
            class_slug,
            event_slug,
            session_date,
            session_period,
            customer_name,
            customer_email,
            quantity,
            status,
            expires_at,
            created_at,
            makerspace_payments!inner (
                provider,
                reference,
                environment,
                amount,
                currency,
                status,
                provider_status,
                provider_transaction_id,
                paid_at,
                verified_at,
                created_at
            )
        `)
        .eq('id', id)
        .maybeSingle();

    if (error) throw new AppError('Studio orders are temporarily unavailable.', 503, 'storage_unavailable');
    if (!data) throw new AppError('We could not find that order.', 404, 'order_not_found');
    return studioOrderFromBooking(data);
}
