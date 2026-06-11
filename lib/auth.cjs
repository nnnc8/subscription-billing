const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'sb_session';
const OAUTH_STATE_COOKIE_NAME = 'sb_oauth_state';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const OAUTH_STATE_MAX_AGE_MS = OAUTH_STATE_MAX_AGE_SECONDS * 1000;

function base64UrlEncode(value) {
    return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
    return Buffer.from(value, 'base64url');
}

function signPayload(payload, secret) {
    return crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('base64url');
}

function sanitizeSessionUser(user) {
    if (!user || typeof user !== 'object') return null;
    const email = typeof user.email === 'string' ? user.email.toLowerCase() : '';
    if (!email) return null;
    const result = { email };
    if (typeof user.name === 'string' && user.name.trim()) {
        result.name = user.name.trim();
    }
    return result;
}

function createSessionCookieValue({ secret, user = null, now = Date.now(), maxAgeMs = SESSION_MAX_AGE_MS } = {}) {
    if (!secret || typeof secret !== 'string') {
        throw new Error('APP_SESSION_SECRET is required');
    }
    const payload = base64UrlEncode(JSON.stringify({
        v: 1,
        iat: now,
        exp: now + maxAgeMs,
        user: sanitizeSessionUser(user)
    }));
    return `${payload}.${signPayload(payload, secret)}`;
}

function verifySessionCookieValue(value, { secret, now = Date.now() } = {}) {
    if (!value || typeof value !== 'string' || !secret) {
        return { ok: false, reason: 'missing' };
    }

    const parts = value.split('.');
    if (parts.length !== 2) {
        return { ok: false, reason: 'malformed' };
    }

    const [payload, signature] = parts;
    const expectedSignature = signPayload(payload, secret);
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
        return { ok: false, reason: 'signature' };
    }

    let parsed;
    try {
        parsed = JSON.parse(base64UrlDecode(payload).toString('utf8'));
    } catch (_) {
        return { ok: false, reason: 'payload' };
    }

    if (parsed.v !== 1 || !Number.isFinite(parsed.exp) || parsed.exp <= now) {
        return { ok: false, reason: 'expired' };
    }

    return { ok: true, session: parsed };
}

function createOAuthStateValue() {
    return crypto.randomBytes(32).toString('base64url');
}

module.exports = {
    OAUTH_STATE_COOKIE_NAME,
    SESSION_COOKIE_NAME,
    SESSION_MAX_AGE_SECONDS,
    SESSION_MAX_AGE_MS,
    OAUTH_STATE_MAX_AGE_SECONDS,
    OAUTH_STATE_MAX_AGE_MS,
    createOAuthStateValue,
    createSessionCookieValue,
    verifySessionCookieValue
};
