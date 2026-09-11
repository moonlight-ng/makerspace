import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import studioOrdersHandler from '../api/studio/orders.js';
import {
    clearStudioSessionCookie,
    createStudioSession,
    getAllowedStudioEmails,
    getStudioSession,
    normalizeStudioEmail,
    requestStudioCode,
    STUDIO_SESSION_COOKIE,
    STUDIO_SESSION_SECONDS,
    studioSessionCookie,
    verifyStudioCode,
    verifyStudioSession,
} from '../server/studio-auth.js';
import {
    deriveStudioOrderState,
    getStudioOrder,
    listStudioOrders,
    paystackDashboardUrl,
    validateStudioOrderQuery,
} from '../server/studio-orders.js';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');
const STUDIO_ENV = {
    NODE_ENV: 'production',
    STUDIO_ALLOWED_EMAILS: ' MakerSpace@16by16.co, ope@moonlight.ng, Info@16by16.co,invalid ',
    STUDIO_SESSION_SECRET: 'this-is-a-test-secret-with-more-than-32-bytes',
};

function responseRecorder() {
    return {
        headers: {},
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        end(body) { this.body = body; },
    };
}

test('Studio email allowlist is normalized and invalid entries are discarded', () => {
    assert.equal(normalizeStudioEmail(' MakerSpace@16by16.co '), 'makerspace@16by16.co');
    assert.equal(normalizeStudioEmail('not-an-email'), null);
    assert.deepEqual(
        [...getAllowedStudioEmails(STUDIO_ENV)],
        ['makerspace@16by16.co', 'ope@moonlight.ng', 'info@16by16.co'],
    );
});

test('unapproved Studio code requests return generically without contacting Auth', async () => {
    let called = false;
    const auth = {
        async signInWithOtp() {
            called = true;
            return { error: null };
        },
    };

    assert.deepEqual(
        await requestStudioCode({ email: 'visitor@example.com' }, STUDIO_ENV, auth),
        { accepted: true },
    );
    assert.equal(called, false);
});

test('approved Studio code requests and verification use Supabase email OTP', async () => {
    const calls = [];
    const auth = {
        async signInWithOtp(input) {
            calls.push({ method: 'request', input });
            return { error: null };
        },
        async verifyOtp(input) {
            calls.push({ method: 'verify', input });
            return { data: { user: { email: 'makerspace@16by16.co' } }, error: null };
        },
    };

    await requestStudioCode({ email: 'Makerspace@16by16.co' }, STUDIO_ENV, auth);
    const verified = await verifyStudioCode({
        email: 'makerspace@16by16.co',
        token: '123456',
    }, STUDIO_ENV, auth);

    assert.equal(verified.email, 'makerspace@16by16.co');
    assert.ok(verifyStudioSession(verified.token, STUDIO_ENV));
    assert.deepEqual(calls[0], {
        method: 'request',
        input: {
            email: 'makerspace@16by16.co',
            options: { shouldCreateUser: true },
        },
    });
    assert.deepEqual(calls[1], {
        method: 'verify',
        input: { email: 'makerspace@16by16.co', token: '123456', type: 'email' },
    });
});

test('Supabase uses the OTP email body for first-time and returning Studio users', async () => {
    const config = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8');
    const template = await readFile(new URL('../supabase/templates/studio-login.html', import.meta.url), 'utf8');

    assert.match(config, /\[auth\.email\.smtp\][\s\S]*?host = "smtp\.resend\.com"[\s\S]*?pass = "env\(RESEND_API_KEY\)"[\s\S]*?admin_email = "makerspace@moonlight\.ng"/);
    assert.match(config, /\[auth\.rate_limit\][\s\S]*?email_sent = 60/);
    assert.match(config, /\[auth\.email\.template\.magic_link\][\s\S]*?content_path = "\.\/supabase\/templates\/studio-login\.html"/);
    assert.match(config, /\[auth\.email\.template\.confirmation\][\s\S]*?content_path = "\.\/supabase\/templates\/studio-login\.html"/);
    assert.match(template, /{{ \.Token }}/);
    assert.doesNotMatch(template, /{{ \.ConfirmationURL }}/);
});

test('Studio shows one derived order status and labels environment separately', async () => {
    const html = await readFile(new URL('../pages/studio/index.html', import.meta.url), 'utf8');
    const script = await readFile(new URL('../app/scripts/studio.js', import.meta.url), 'utf8');

    assert.doesNotMatch(html, /data-detail="(?:bookingStatus|paymentStatus)"/);
    assert.doesNotMatch(script, /studio-order-mode/);
    assert.match(html, /<dt>Environment<\/dt><dd data-detail="environment">/);
});

test('Studio sessions reject tampering, expiry, and removed allowlist entries', () => {
    const token = createStudioSession('makerspace@16by16.co', STUDIO_ENV, NOW);
    assert.deepEqual(verifyStudioSession(token, STUDIO_ENV, NOW), {
        email: 'makerspace@16by16.co',
        expiresAt: Math.floor(NOW / 1_000) + STUDIO_SESSION_SECONDS,
    });
    assert.equal(verifyStudioSession(`${token}x`, STUDIO_ENV, NOW), null);
    assert.equal(
        verifyStudioSession(token, STUDIO_ENV, NOW + STUDIO_SESSION_SECONDS * 1_000),
        null,
    );
    assert.equal(
        verifyStudioSession(token, { ...STUDIO_ENV, STUDIO_ALLOWED_EMAILS: 'ope@moonlight.ng' }, NOW),
        null,
    );
});

test('Studio cookies are HTTP-only, secure, strict, and clearable', () => {
    const token = createStudioSession('makerspace@16by16.co', STUDIO_ENV, NOW);
    const cookie = studioSessionCookie(token, STUDIO_ENV, NOW);
    assert.match(cookie, new RegExp(`^${STUDIO_SESSION_COOKIE}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, new RegExp(`Max-Age=${STUDIO_SESSION_SECONDS}`));

    const request = { headers: { cookie } };
    assert.equal(getStudioSession(request, STUDIO_ENV, NOW).email, 'makerspace@16by16.co');
    assert.match(clearStudioSessionCookie(STUDIO_ENV), /Max-Age=0/);
});

test('Studio order query validation bounds filters and pagination', () => {
    assert.deepEqual(validateStudioOrderQuery({}), {
        query: null,
        status: 'all',
        environment: 'all',
        limit: 30,
        offset: 0,
    });
    assert.deepEqual(validateStudioOrderQuery({
        q: ' maker ',
        status: 'PAID',
        environment: 'test',
        limit: '50',
        offset: '100',
    }), {
        query: 'maker',
        status: 'paid',
        environment: 'test',
        limit: 50,
        offset: 100,
    });
    assert.throws(() => validateStudioOrderQuery({ status: 'refunded' }), /invalid/i);
    assert.throws(() => validateStudioOrderQuery({ limit: 101 }), /invalid/i);
});

test('Studio display state prioritizes paid, cancelled, expired, failed, then pending', () => {
    const activeBooking = { status: 'reserved', expires_at: '2026-09-10T12:30:00.000Z' };
    assert.equal(deriveStudioOrderState(activeBooking, { status: 'pending' }, NOW), 'pending');
    assert.equal(deriveStudioOrderState(activeBooking, { status: 'success' }, NOW), 'paid');
    assert.equal(deriveStudioOrderState({ ...activeBooking, status: 'cancelled' }, { status: 'failed' }, NOW), 'cancelled');
    assert.equal(deriveStudioOrderState({ ...activeBooking, expires_at: '2026-09-10T11:30:00.000Z' }, { status: 'pending' }, NOW), 'expired');
    assert.equal(deriveStudioOrderState(activeBooking, { status: 'failed' }, NOW), 'failed');
});

test('Studio order listing calls the restricted search RPC and maps safe output', async () => {
    const calls = [];
    const supabase = {
        async rpc(name, input) {
            calls.push({ name, input });
            return {
                data: {
                    total: 2,
                    orders: [{
                        booking_id: '5a15f50d-6e09-4dc1-9375-c9b09a3cc451',
                        class_slug: 'introduction-to-3d-printing',
                        event_slug: 'intro-to-3d-printing-2026-09-10',
                        session_date: '2026-09-10',
                        session_period: 'evening',
                        customer_name: 'Test Maker',
                        customer_email: 'maker@example.com',
                        quantity: 1,
                        amount: 3_000_000,
                        currency: 'NGN',
                        order_state: 'paid',
                        booking_status: 'paid',
                        payment_status: 'success',
                        environment: 'test',
                        reference: 'mksp-example',
                        provider_transaction_id: '12345',
                        booking_created_at: '2026-09-10T10:00:00.000Z',
                    }],
                },
                error: null,
            };
        },
    };

    const result = await listStudioOrders({ q: 'maker', limit: 1 }, {}, supabase);
    assert.equal(result.orders[0].workshop, 'Intro to 3D Printing');
    assert.equal(result.orders[0].customerEmail, 'maker@example.com');
    assert.equal(result.orders[0].paystackDashboardUrl, 'https://dashboard.paystack.com/#/transactions/12345');
    assert.equal(result.total, 2);
    assert.equal(result.hasMore, true);
    assert.deepEqual(calls[0], {
        name: 'list_makerspace_studio_orders',
        input: {
            p_query: 'maker',
            p_status: 'all',
            p_environment: 'all',
            p_limit: 1,
            p_offset: 0,
        },
    });
});

test('Studio detail lookup reports missing orders without exposing storage details', async () => {
    const builder = {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: null, error: null }; },
    };
    const supabase = { from() { return builder; } };

    await assert.rejects(
        getStudioOrder('5a15f50d-6e09-4dc1-9375-c9b09a3cc451', {}, supabase),
        (error) => error.status === 404 && error.code === 'order_not_found',
    );
});

test('Paystack links use a transaction deep link when possible and a safe fallback otherwise', () => {
    assert.equal(
        paystackDashboardUrl('transaction/unsafe'),
        'https://dashboard.paystack.com/#/transactions/transaction%2Funsafe',
    );
    assert.equal(paystackDashboardUrl(null), 'https://dashboard.paystack.com/#/transactions');
});

test('Studio order API rejects unauthenticated requests before querying storage', async () => {
    const response = responseRecorder();
    await studioOrdersHandler({ method: 'GET', headers: {}, url: '/api/studio/orders' }, response);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), {
        error: 'Studio login required.',
        code: 'studio_login_required',
    });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-frame-options'], 'DENY');
});

test('Studio uses the minimal neutral master-detail order design', async () => {
    const [html, css, script] = await Promise.all([
        readFile(new URL('../pages/studio/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../app/styles/studio.css', import.meta.url), 'utf8'),
        readFile(new URL('../app/scripts/studio.js', import.meta.url), 'utf8'),
    ]);

    assert.match(html, /class="studio-workspace"/);
    assert.match(html, /class="studio-detail-facts"/);
    assert.match(html, /class="studio-header-back"[^>]*data-close-order/);
    assert.doesNotMatch(html, /studio-view-all/);
    assert.match(html, /<title>Studio - Makerspace<\/title>/);
    assert.doesNotMatch(html, /<svg/);
    assert.match(css, /--studio-soft:\s*#efeee9/i);
    assert.match(css, /\.studio-order-row\.is-selected[\s\S]*?background:\s*var\(--studio-soft\)/);
    assert.match(css, /\.studio-account button\s*\{[\s\S]*?border-bottom:\s*0/);
    assert.match(script, /\/api\/studio\/orders/);
});
