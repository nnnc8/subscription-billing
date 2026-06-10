const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'sb_session';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const PASSWORD_HASH_PREFIX = 'scrypt';
const PASSWORD_KEY_LENGTH = 64;

function base64UrlEncode(value) {
    return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
    return Buffer.from(value, 'base64url');
}

function createPasswordHash(password, options = {}) {
    if (typeof password !== 'string' || password.length === 0) {
        throw new Error('Password cannot be empty');
    }
    const salt = options.salt || crypto.randomBytes(16).toString('base64url');
    const derived = crypto.scryptSync(password, salt, PASSWORD_KEY_LENGTH);
    return `${PASSWORD_HASH_PREFIX}$${salt}$${derived.toString('base64url')}`;
}

function verifyPassword(password, storedHash) {
    if (typeof password !== 'string' || typeof storedHash !== 'string') return false;
    const [prefix, salt, encodedHash] = storedHash.split('$');
    if (prefix !== PASSWORD_HASH_PREFIX || !salt || !encodedHash) return false;

    let expected;
    try {
        expected = base64UrlDecode(encodedHash);
    } catch (_) {
        return false;
    }

    const actual = crypto.scryptSync(password, salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function signPayload(payload, secret) {
    return crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('base64url');
}

function createSessionCookieValue({ secret, now = Date.now(), maxAgeMs = SESSION_MAX_AGE_MS } = {}) {
    if (!secret || typeof secret !== 'string') {
        throw new Error('APP_SESSION_SECRET is required');
    }
    const payload = base64UrlEncode(JSON.stringify({
        v: 1,
        iat: now,
        exp: now + maxAgeMs
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

module.exports = {
    SESSION_COOKIE_NAME,
    SESSION_MAX_AGE_SECONDS,
    SESSION_MAX_AGE_MS,
    createPasswordHash,
    createSessionCookieValue,
    verifyPassword,
    verifySessionCookieValue
};
