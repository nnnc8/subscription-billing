import crypto from 'node:crypto';
import type { SessionCookiePayload, SessionVerificationResult } from '../src/types/billing.js';

export const SESSION_COOKIE_NAME = 'sb_session';
export const OAUTH_STATE_COOKIE_NAME = 'sb_oauth_state';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
export const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
export const OAUTH_STATE_MAX_AGE_MS = OAUTH_STATE_MAX_AGE_SECONDS * 1000;

function base64UrlEncode(value: string): string {
    return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value: string): Buffer {
    return Buffer.from(value, 'base64url');
}

function signPayload(payload: string, secret: string): string {
    return crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('base64url');
}

function sanitizeSessionUser(user: unknown): { email: string; name?: string } | null {
    if (!user || typeof user !== 'object') return null;
    const u = user as Record<string, unknown>;
    const email = typeof u.email === 'string' ? u.email.toLowerCase() : '';
    if (!email) return null;
    const result: { email: string; name?: string } = { email };
    if (typeof u.name === 'string' && u.name.trim()) {
        result.name = u.name.trim();
    }
    return result;
}

export function createSessionCookieValue({ secret, user = null, now = Date.now(), maxAgeMs = SESSION_MAX_AGE_MS }: { secret: string; user?: unknown; now?: number; maxAgeMs?: number } = { secret: '' }): string {
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

export function verifySessionCookieValue(value: string, { secret, now = Date.now() }: { secret: string; now?: number }): SessionVerificationResult {
    if (!value || typeof value !== 'string' || !secret) {
        return { ok: false, reason: 'missing' };
    }

    const parts = value.split('.');
    if (parts.length !== 2) {
        return { ok: false, reason: 'malformed' };
    }

    const payload = parts[0];
    const signature = parts[1];
    if (!payload || !signature) {
        return { ok: false, reason: 'malformed' };
    }
    const expectedSignature = signPayload(payload, secret);
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
        return { ok: false, reason: 'signature' };
    }

    let parsed: SessionCookiePayload;
    try {
        parsed = JSON.parse(base64UrlDecode(payload).toString('utf8'));
    } catch {
        return { ok: false, reason: 'payload' };
    }

    if (parsed.v !== 1 || !Number.isFinite(parsed.exp) || parsed.exp <= now) {
        return { ok: false, reason: 'expired' };
    }

    return { ok: true, session: parsed };
}

export function createOAuthStateValue(): string {
    return crypto.randomBytes(32).toString('base64url');
}
