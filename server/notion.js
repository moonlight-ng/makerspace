import { getWorkshop } from './config.js';
import { getSupabaseClient } from './supabase.js';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2025-09-03';
const MAX_NOTION_ATTEMPTS = 3;

export class NotionSyncError extends Error {
    constructor(message, status = 503, code = 'notion_sync_failed') {
        super(message);
        this.name = 'NotionSyncError';
        this.status = status;
        this.code = code;
    }
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function textContent(value) {
    return [{
        type: 'text',
        text: { content: String(value || '').slice(0, 2_000) },
    }];
}

function selectValue(value) {
    return value ? { name: value } : null;
}

function dateValue(value) {
    return value ? { start: value } : null;
}

function titleCase(value) {
    const cleaned = String(value || '').trim();
    return cleaned ? `${cleaned[0].toUpperCase()}${cleaned.slice(1)}` : '';
}

function paymentForBooking(booking) {
    if (Array.isArray(booking.makerspace_payments)) {
        return booking.makerspace_payments[0] || {};
    }
    return booking.makerspace_payments || {};
}

export function getNotionConfig(env = process.env) {
    const apiKey = String(env.NOTION_API_KEY || '').trim();
    const dataSourceId = String(env.NOTION_DATA_SOURCE_ID || '').trim().replace(/^collection:\/\//, '');

    if (!apiKey && !dataSourceId) return null;
    if (!apiKey || !dataSourceId) {
        throw new NotionSyncError(
            'Notion sync requires both NOTION_API_KEY and NOTION_DATA_SOURCE_ID.',
            503,
            'notion_configuration_error',
        );
    }

    return { apiKey, dataSourceId };
}

export function notionPropertiesForBooking(booking, syncedAt = new Date().toISOString()) {
    const payment = paymentForBooking(booking);
    const workshop = getWorkshop(booking.class_slug);
    const customer = String(booking.customer_name || '').trim();
    const sessionDate = String(booking.session_date || '').trim();

    return {
        Booking: { title: textContent(`${customer} — ${sessionDate}`) },
        'Booking ID': { rich_text: textContent(booking.id) },
        Customer: { rich_text: textContent(customer) },
        Email: { email: booking.customer_email || null },
        Workshop: { rich_text: textContent(workshop?.name || booking.class_slug) },
        Event: { rich_text: textContent(booking.event_slug) },
        'Session Date': { date: dateValue(sessionDate) },
        Period: { select: selectValue(titleCase(booking.session_period)) },
        Quantity: { number: Number(booking.quantity || 1) },
        Amount: { number: Number(payment.amount || 0) / 100 },
        Currency: { select: selectValue(payment.currency || 'NGN') },
        'Booking Status': { select: selectValue(titleCase(booking.status)) },
        'Payment Status': { select: selectValue(titleCase(payment.status)) },
        'Payment Reference': { rich_text: textContent(payment.reference) },
        Environment: { select: selectValue(titleCase(payment.environment)) },
        'Booked At': { date: dateValue(booking.created_at) },
        'Hold Expires At': { date: dateValue(booking.expires_at) },
        'Paid At': { date: dateValue(payment.paid_at) },
        'Last Synced At': { date: dateValue(syncedAt) },
    };
}

async function notionRequest(path, options, config, request = fetch) {
    let lastError;

    for (let attempt = 0; attempt < MAX_NOTION_ATTEMPTS; attempt += 1) {
        try {
            const response = await request(`${NOTION_API_BASE}${path}`, {
                ...options,
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                    'Notion-Version': NOTION_API_VERSION,
                    ...options.headers,
                },
                signal: AbortSignal.timeout(12_000),
            });
            const payload = await response.json().catch(() => ({}));
            if (response.ok) return payload;

            const message = String(payload.message || `Notion returned HTTP ${response.status}.`).slice(0, 500);
            const error = new NotionSyncError(message, response.status, payload.code || 'notion_api_error');
            if (![429, 500, 502, 503, 504, 529].includes(response.status)) throw error;

            lastError = error;
            if (attempt < MAX_NOTION_ATTEMPTS - 1) {
                const retryAfter = Number(response.headers?.get?.('retry-after'));
                await wait(Number.isFinite(retryAfter) && retryAfter > 0
                    ? Math.min(retryAfter * 1_000, 5_000)
                    : 500 * (2 ** attempt));
            }
        } catch (error) {
            if (error instanceof NotionSyncError && ![429, 500, 502, 503, 504, 529].includes(error.status)) {
                throw error;
            }
            lastError = error;
            if (attempt < MAX_NOTION_ATTEMPTS - 1) await wait(500 * (2 ** attempt));
        }
    }

    throw lastError instanceof NotionSyncError
        ? lastError
        : new NotionSyncError(String(lastError?.message || 'Notion could not be reached.').slice(0, 500));
}

async function findNotionPage(bookingId, config, request) {
    const result = await notionRequest(
        `/data_sources/${encodeURIComponent(config.dataSourceId)}/query`,
        {
            method: 'POST',
            body: JSON.stringify({
                filter: {
                    property: 'Booking ID',
                    rich_text: { equals: bookingId },
                },
                page_size: 1,
            }),
        },
        config,
        request,
    );

    return result.results?.[0]?.id || null;
}

export async function upsertNotionBooking(booking, config, request = fetch) {
    const properties = notionPropertiesForBooking(booking);
    let pageId = booking.notion_page_id || null;

    if (pageId) {
        try {
            await notionRequest(
                `/pages/${encodeURIComponent(pageId)}`,
                { method: 'PATCH', body: JSON.stringify({ properties }) },
                config,
                request,
            );
            return pageId;
        } catch (error) {
            if (error.status !== 404) throw error;
            pageId = null;
        }
    }

    pageId = await findNotionPage(booking.id, config, request);
    if (pageId) {
        await notionRequest(
            `/pages/${encodeURIComponent(pageId)}`,
            { method: 'PATCH', body: JSON.stringify({ properties }) },
            config,
            request,
        );
        return pageId;
    }

    const page = await notionRequest(
        '/pages',
        {
            method: 'POST',
            body: JSON.stringify({
                parent: {
                    type: 'data_source_id',
                    data_source_id: config.dataSourceId,
                },
                properties,
            }),
        },
        config,
        request,
    );

    if (!page.id) throw new NotionSyncError('Notion created a booking without returning its page ID.');
    return page.id;
}

async function releaseClaim(supabase, bookingId, syncVersion, error) {
    await supabase
        .from('makerspace_bookings')
        .update({
            notion_sync_status: 'pending',
            notion_sync_started_at: null,
            notion_sync_error: String(error?.message || error || 'Unknown sync failure').slice(0, 500),
        })
        .eq('id', bookingId)
        .eq('notion_sync_version', syncVersion)
        .eq('notion_sync_status', 'processing');
}

export async function syncPendingNotionBookings({
    env = process.env,
    supabase = getSupabaseClient(env),
    bookingId = null,
    limit = 10,
    request = fetch,
} = {}) {
    const config = getNotionConfig(env);
    if (!config) return { configured: false, claimed: 0, synced: 0, failed: 0 };

    const { data: claims, error: claimError } = await supabase.rpc('claim_makerspace_notion_sync', {
        p_limit: limit,
        p_booking_id: bookingId,
    });
    if (claimError) throw new NotionSyncError(`Could not claim Notion sync work: ${claimError.message}`);
    if (!claims?.length) return { configured: true, claimed: 0, synced: 0, failed: 0 };

    const claimVersions = new Map(claims.map((claim) => [claim.booking_id, claim.sync_version]));
    const bookingIds = [...claimVersions.keys()];
    const { data: bookings, error: bookingError } = await supabase
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
            notion_page_id,
            makerspace_payments (
                reference,
                environment,
                amount,
                currency,
                status,
                provider_status,
                paid_at,
                created_at
            )
        `)
        .in('id', bookingIds);

    if (bookingError) {
        await Promise.all(claims.map((claim) => releaseClaim(
            supabase,
            claim.booking_id,
            claim.sync_version,
            bookingError,
        )));
        throw new NotionSyncError(`Could not load booking sync data: ${bookingError.message}`);
    }

    let synced = 0;
    let failed = 0;
    const seen = new Set();

    for (const booking of bookings || []) {
        const syncVersion = claimVersions.get(booking.id);
        seen.add(booking.id);
        try {
            const pageId = await upsertNotionBooking(booking, config, request);
            const { error } = await supabase
                .from('makerspace_bookings')
                .update({
                    notion_page_id: pageId,
                    notion_sync_status: 'synced',
                    notion_synced_version: syncVersion,
                    notion_sync_started_at: null,
                    notion_synced_at: new Date().toISOString(),
                    notion_sync_error: null,
                })
                .eq('id', booking.id)
                .eq('notion_sync_version', syncVersion)
                .eq('notion_sync_status', 'processing');
            if (error) throw error;
            synced += 1;
        } catch (error) {
            failed += 1;
            await releaseClaim(supabase, booking.id, syncVersion, error);
        }
    }

    for (const claim of claims) {
        if (seen.has(claim.booking_id)) continue;
        failed += 1;
        await releaseClaim(supabase, claim.booking_id, claim.sync_version, 'Booking record was not found.');
    }

    return { configured: true, claimed: claims.length, synced, failed };
}

export async function syncBookingToNotionBestEffort(
    bookingId,
    env = process.env,
    supabase = getSupabaseClient(env),
) {
    if (!env.NOTION_API_KEY && !env.NOTION_DATA_SOURCE_ID) return false;

    try {
        const result = await syncPendingNotionBookings({ env, supabase, bookingId, limit: 1 });
        return result.synced === 1;
    } catch (error) {
        console.error(`[notion-sync] Booking ${bookingId} remains queued: ${error.message}`);
        return false;
    }
}
