import { createHmac, timingSafeEqual } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

import { AppError } from './errors.js';

export const STUDIO_SESSION_COOKIE = 'makerspace_studio_session';
export const STUDIO_SESSION_SECONDS = 7 * 24 * 60 * 60;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function required(env, key) {
    const value = String(env?.[key] || '').trim();
    if (!value) throw new AppError(`Server configuration is missing ${key}.`, 503, 'configuration_error');
    return value;
}

export function normalizeStudioEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    return email.length <= 160 && EMAIL_PATTERN.test(email) ? email : null;
}

export function getAllowedStudioEmails(env = process.env) {
    return new Set(
        String(env?.STUDIO_ALLOWED_EMAILS || '')
            .split(',')
            .map(normalizeStudioEmail)
            .filter(Boolean),
    );
}

export function isAllowedStudioEmail(email, env = process.env) {
    const normalized = normalizeStudioEmail(email);
    return Boolean(normalized && getAllowedStudioEmails(env).has(normalized));
}

function sessionSecret(env) {
    const secret = required(env, 'STUDIO_SESSION_SECRET');
    if (Buffer.byteLength(secret, 'utf8') < 32) {
        throw new AppError(
            'STUDIO_SESSION_SECRET must contain at least 32 bytes.',
            503,
            'configuration_error',
        );
    }
    return secret;
}

function encode(value) {
    return Buffer.from(value, 'utf8').toString('base64url');
}

function sign(value, secret) {
    return createHmac('sha256', secret).update(value).digest('base64url');
}

function signaturesMatch(left, right) {
    try {
        const leftBuffer = Buffer.from(left, 'base64url');
        const rightBuffer = Buffer.from(right, 'base64url');
        return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
    } catch {
        return false;
    }
}

export function createStudioSession(email, env = process.env, now = Date.now()) {
    const normalized = normalizeStudioEmail(email);
    if (!normalized || !isAllowedStudioEmail(normalized, env)) {
        throw new AppError('This email cannot access Studio.', 403, 'studio_access_denied');
    }

    const issuedAt = Math.floor(now / 1_000);
    const payload = encode(JSON.stringify({
        version: 1,
        email: normalized,
        issuedAt,
        expiresAt: issuedAt + STUDIO_SESSION_SECONDS,
    }));

    return `${payload}.${sign(payload, sessionSecret(env))}`;
}

export function verifyStudioSession(token, env = process.env, now = Date.now()) {
    const [payload, signature, extra] = String(token || '').split('.');
    if (!payload || !signature || extra) return null;

    const expected = sign(payload, sessionSecret(env));
    if (!signaturesMatch(signature, expected)) return null;

    try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        const email = normalizeStudioEmail(session.email);
        const nowSeconds = Math.floor(now / 1_000);
        if (
            session.version !== 1
            || !email
            || !Number.isInteger(session.issuedAt)
            || !Number.isInteger(session.expiresAt)
            || session.issuedAt > nowSeconds + 60
            || session.expiresAt <= nowSeconds
            || session.expiresAt - session.issuedAt !== STUDIO_SESSION_SECONDS
            || !isAllowedStudioEmail(email, env)
        ) return null;

        return { email, expiresAt: session.expiresAt };
    } catch {
        return null;
    }
}

export function parseCookies(request) {
    const cookies = {};
    for (const part of String(request?.headers?.cookie || '').split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        const key = part.slice(0, separator).trim();
        if (!key) continue;
        try {
            cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
        } catch {
            cookies[key] = '';
        }
    }
    return cookies;
}

export function getStudioSession(request, env = process.env, now = Date.now()) {
    const token = parseCookies(request)[STUDIO_SESSION_COOKIE];
    if (!token) return null;
    return verifyStudioSession(token, env, now);
}

export function requireStudioSession(request, env = process.env, now = Date.now()) {
    const session = getStudioSession(request, env, now);
    if (!session) throw new AppError('Studio login required.', 401, 'studio_login_required');
    return session;
}

export function studioSessionCookie(token, env = process.env, now = Date.now()) {
    const expires = new Date(now + STUDIO_SESSION_SECONDS * 1_000).toUTCString();
    const secure = env?.NODE_ENV === 'development' ? '' : '; Secure';
    return `${STUDIO_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${STUDIO_SESSION_SECONDS}; Expires=${expires}`;
}

export function clearStudioSessionCookie(env = process.env) {
    const secure = env?.NODE_ENV === 'development' ? '' : '; Secure';
    return `${STUDIO_SESSION_COOKIE}=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function createStudioAuthClient(env = process.env) {
    return createClient(
        required(env, 'SUPABASE_URL').replace(/\/$/, ''),
        required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
        {
            auth: {
                autoRefreshToken: false,
                detectSessionInUrl: false,
                persistSession: false,
            },
        },
    );
}

export async function requestStudioCode(
    input,
    env = process.env,
    auth = null,
) {
    const email = normalizeStudioEmail(input?.email);
    if (!email || !isAllowedStudioEmail(email, env)) return { accepted: true };

    const studioAuth = auth || createStudioAuthClient(env).auth;
    const { error } = await studioAuth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
    });

    if (error) {
        const status = Number(error.status) === 429 ? 429 : 503;
        throw new AppError(
            status === 429
                ? 'Please wait before requesting another code.'
                : 'We could not send a login code. Please try again.',
            status,
            status === 429 ? 'otp_rate_limited' : 'otp_unavailable',
        );
    }

    return { accepted: true };
}

export async function verifyStudioCode(
    input,
    env = process.env,
    auth = null,
) {
    const email = normalizeStudioEmail(input?.email);
    const token = String(input?.token || '').trim();
    if (!email || !isAllowedStudioEmail(email, env) || !/^\d{6}$/.test(token)) {
        throw new AppError('The code is invalid or has expired.', 401, 'invalid_studio_code');
    }

    const studioAuth = auth || createStudioAuthClient(env).auth;
    const { data, error } = await studioAuth.verifyOtp({ email, token, type: 'email' });
    const verifiedEmail = normalizeStudioEmail(data?.user?.email);
    if (error || verifiedEmail !== email || !isAllowedStudioEmail(verifiedEmail, env)) {
        throw new AppError('The code is invalid or has expired.', 401, 'invalid_studio_code');
    }

    return { email, token: createStudioSession(email, env) };
}

export function applyStudioSecurityHeaders(response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
}
