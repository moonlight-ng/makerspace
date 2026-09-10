import assert from 'node:assert/strict'
import test from 'node:test'

import {
    EVENTS,
    getEvent,
    getWorkshop,
    MAKERSPACE_SUBACCOUNT_CODE,
    WORKSHOP,
} from '../server/config.js'
import {
    initializePaystackTransaction,
    PaystackConfigurationError,
    requirePaystackKeys,
    transactionMatchesPayment,
} from '../server/paystack.js'
import { cancelBooking, validateBooking, validateBookingCancellation } from '../server/bookings.js'
import {
    getNotionConfig,
    notionPropertiesForBooking,
    upsertNotionBooking,
} from '../server/notion.js'

const validInput = {
    eventSlug: 'intro-to-3d-printing-2026-09-03',
    quantity: 1,
    name: 'Test Maker',
    email: 'maker@example.com',
}

const testEnv = {
    PAYSTACK_SECRET_KEY: 'sk_test_example',
    PAYSTACK_CALLBACK_URL: 'https://makerspace.example/payment-complete/',
}

test('Paystack secret key determines the transaction environment', () => {
    assert.deepEqual(requirePaystackKeys(testEnv), {
        secretKey: 'sk_test_example',
        environment: 'test',
    })
    assert.throws(() => requirePaystackKeys({}), PaystackConfigurationError)
    assert.throws(
        () => requirePaystackKeys({ PAYSTACK_SECRET_KEY: 'not-a-secret-key' }),
        PaystackConfigurationError,
    )
})

test('booking details are derived from the selected event', () => {
    assert.deepEqual(validateBooking(validInput), {
        ...validInput,
        classSlug: WORKSHOP.slug,
        date: '2026-09-03',
        period: 'evening',
    })
    assert.equal(validateBooking({ ...validInput, eventSlug: 'missing-event' }).error, 'Choose a valid event.')
    assert.equal(validateBooking({ ...validInput, quantity: 0 }).error, 'This session accepts one booking.')
    assert.equal(validateBooking({ ...validInput, quantity: 2 }).error, 'This session accepts one booking.')
})

test('the calendar exposes one workshop across dated events', () => {
    assert.equal(WORKSHOP.name, 'Intro to 3D Printing')
    assert.equal(getWorkshop(WORKSHOP.slug), WORKSHOP)
    assert.equal(getWorkshop('introduction-to-clay'), null)
    assert.equal(EVENTS.length, 8)
    assert.equal(getEvent(validInput.eventSlug).amount, 3_000_000)
    assert.equal(new Set(EVENTS.map((event) => event.amount)).size, 1)
    assert.deepEqual(new Set(EVENTS.map((event) => event.capacity)), new Set([1]))
})

test('booking cancellation requires the reservation ID and matching payment reference', () => {
    const cancellation = {
        bookingId: '5a15f50d-6e09-4dc1-9375-c9b09a3cc451',
        reference: 'mksp-example.123',
    }

    assert.deepEqual(validateBookingCancellation(cancellation), cancellation)
    assert.equal(
        validateBookingCancellation({ ...cancellation, bookingId: 'not-a-booking' }).error,
        'The reservation ID is invalid.',
    )
    assert.equal(
        validateBookingCancellation({ ...cancellation, reference: 'bad reference' }).error,
        'The payment reference is invalid.',
    )
})

test('booking cancellation is delegated to one atomic database operation', async () => {
    const cancellation = {
        bookingId: '5a15f50d-6e09-4dc1-9375-c9b09a3cc451',
        reference: 'mksp-example',
    }
    const calls = []
    const supabase = {
        async rpc(name, input) {
            calls.push({ name, input })
            return { data: { ok: true, already_cancelled: false }, error: null }
        },
    }

    assert.deepEqual(await cancelBooking(cancellation, {}, supabase), {
        cancelled: true,
        alreadyCancelled: false,
    })
    assert.deepEqual(calls, [{
        name: 'cancel_makerspace_booking',
        input: {
            p_booking_id: cancellation.bookingId,
            p_reference: cancellation.reference,
        },
    }])
})

test('transaction initialization assigns the Makerspace subaccount', async () => {
    const requests = []
    const request = async (url, options) => {
        requests.push({ url, options })
        return {
            ok: true,
            async json() {
                return {
                    status: true,
                    data: {
                        access_code: 'access-example',
                        authorization_url: 'https://checkout.paystack.com/access-example',
                        reference: 'mksp-example',
                    },
                }
            },
        }
    }

    const checkout = await initializePaystackTransaction({
        email: 'maker@example.com',
        amount: 3_000_000,
        currency: 'NGN',
        reference: 'mksp-example',
        metadata: { event_slug: validInput.eventSlug },
    }, testEnv, request)

    assert.deepEqual(checkout, {
        accessCode: 'access-example',
        authorizationUrl: 'https://checkout.paystack.com/access-example',
        reference: 'mksp-example',
        environment: 'test',
    })
    const body = JSON.parse(requests[0].options.body)
    assert.equal(requests[0].url, 'https://api.paystack.co/transaction/initialize')
    assert.equal(body.amount, '3000000')
    assert.equal(body.subaccount, MAKERSPACE_SUBACCOUNT_CODE)
    assert.equal(body.callback_url, testEnv.PAYSTACK_CALLBACK_URL)
    assert.deepEqual(JSON.parse(body.metadata), { event_slug: validInput.eventSlug })
})

test('verified transaction must match amount, customer and Makerspace subaccount', () => {
    const payment = {
        reference: 'mksp-example',
        amount: 3_000_000,
        currency: 'NGN',
        customer_email: 'maker@example.com',
        subaccount_code: MAKERSPACE_SUBACCOUNT_CODE,
    }
    const transaction = {
        status: 'success',
        reference: 'mksp-example',
        amount: 3_000_000,
        currency: 'NGN',
        customer: { email: 'Maker@Example.com' },
        subaccount: { subaccount_code: MAKERSPACE_SUBACCOUNT_CODE },
    }

    assert.equal(transactionMatchesPayment(transaction, payment), true)
    assert.equal(transactionMatchesPayment({ ...transaction, amount: 2_999_999 }, payment), false)
    assert.equal(transactionMatchesPayment({ ...transaction, subaccount: {} }, payment), false)
})

test('booking rows are mapped to the Workshop Bookings Notion schema', () => {
    const properties = notionPropertiesForBooking({
        id: '5a15f50d-6e09-4dc1-9375-c9b09a3cc451',
        class_slug: WORKSHOP.slug,
        event_slug: validInput.eventSlug,
        session_date: '2026-09-03',
        session_period: 'evening',
        customer_name: 'Test Maker',
        customer_email: 'maker@example.com',
        quantity: 1,
        status: 'paid',
        expires_at: '2026-09-01T12:30:00.000Z',
        created_at: '2026-09-01T12:00:00.000Z',
        makerspace_payments: [{
            reference: 'mksp-example',
            environment: 'live',
            amount: 3_000_000,
            currency: 'NGN',
            status: 'success',
            paid_at: '2026-09-01T12:05:00.000Z',
        }],
    }, '2026-09-01T12:06:00.000Z')

    assert.equal(properties.Booking.title[0].text.content, 'Test Maker — 2026-09-03')
    assert.equal(properties.Workshop.rich_text[0].text.content, WORKSHOP.name)
    assert.equal(properties.Amount.number, 30_000)
    assert.equal(properties['Booking Status'].select.name, 'Paid')
    assert.equal(properties['Payment Status'].select.name, 'Success')
    assert.deepEqual(properties['Session Date'].date, { start: '2026-09-03' })
    assert.deepEqual(properties['Hold Expires At'].date, { start: '2026-09-01T12:30:00.000Z' })
})

test('Notion configuration is optional only when both settings are absent', () => {
    assert.equal(getNotionConfig({}), null)
    assert.throws(
        () => getNotionConfig({ NOTION_API_KEY: 'ntn_example' }),
        /NOTION_DATA_SOURCE_ID/,
    )
    assert.deepEqual(getNotionConfig({
        NOTION_API_KEY: 'ntn_example',
        NOTION_DATA_SOURCE_ID: 'collection://a56e285a-4b71-47aa-8d81-e11326329459',
    }), {
        apiKey: 'ntn_example',
        dataSourceId: 'a56e285a-4b71-47aa-8d81-e11326329459',
    })
})

test('Notion upsert finds a booking by ID before creating a new page', async () => {
    const requests = []
    const request = async (url, options) => {
        requests.push({ url, options })
        const payload = requests.length === 1
            ? { results: [] }
            : { id: 'notion-page-id' }
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            async json() { return payload },
        }
    }
    const booking = {
        id: '5a15f50d-6e09-4dc1-9375-c9b09a3cc451',
        class_slug: WORKSHOP.slug,
        event_slug: validInput.eventSlug,
        session_date: '2026-09-03',
        session_period: 'evening',
        customer_name: 'Test Maker',
        customer_email: 'maker@example.com',
        quantity: 1,
        status: 'reserved',
        expires_at: '2026-09-01T12:30:00.000Z',
        created_at: '2026-09-01T12:00:00.000Z',
        makerspace_payments: [{
            reference: 'mksp-example',
            environment: 'test',
            amount: 3_000_000,
            currency: 'NGN',
            status: 'pending',
        }],
    }

    assert.equal(await upsertNotionBooking(booking, {
        apiKey: 'ntn_example',
        dataSourceId: 'a56e285a-4b71-47aa-8d81-e11326329459',
    }, request), 'notion-page-id')
    assert.match(requests[0].url, /\/data_sources\/a56e285a-4b71-47aa-8d81-e11326329459\/query$/)
    assert.match(requests[1].url, /\/pages$/)
    assert.equal(JSON.parse(requests[1].options.body).parent.type, 'data_source_id')
})
