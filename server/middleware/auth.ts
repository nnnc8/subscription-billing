import type { Request, RequestHandler } from 'express';
import {
    OAUTH_STATE_COOKIE_NAME,
    OAUTH_STATE_MAX_AGE_SECONDS,
    SESSION_COOKIE_NAME,
    SESSION_MAX_AGE_SECONDS,
    verifySessionCookieValue,
} from '../../lib/auth.js';
import { resolveGoogleRedirectUri } from '../../lib/google-oauth.js';
import type { SessionCookiePayload } from '../../src/types/billing.js';
import { httpError } from './error.js';
import type { Runtime } from '../runtime.js';

declare global {
    /* eslint-disable-next-line @typescript-eslint/no-namespace */
    namespace Express {
        interface Request {
            session?: SessionCookiePayload;
        }
    }
}

export function parseCookies(req: Request): Record<string, string> {
    return String(req.headers.cookie || '')
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .reduce<Record<string, string>>((cookies, part) => {
            const separator = part.indexOf('=');
            if (separator === -1) return cookies;
            try {
                cookies[decodeURIComponent(part.slice(0, separator))] = part.slice(separator + 1);
            } catch {
                // Ignore malformed cookie names; authentication will fail closed.
            }
            return cookies;
        }, {});
}

function buildCookie(
    runtime: Runtime,
    name: string,
    value: string,
    { maxAge, httpOnly = true }: { maxAge: number; httpOnly?: boolean }
): string {
    const pieces = [`${name}=${value}`, 'Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (httpOnly) pieces.push('HttpOnly');
    if (runtime.config.cookieSecure) pieces.push('Secure');
    return pieces.join('; ');
}

export function buildSessionCookie(
    runtime: Runtime,
    value: string,
    { maxAge = SESSION_MAX_AGE_SECONDS }: { maxAge?: number } = {}
): string {
    return buildCookie(runtime, SESSION_COOKIE_NAME, value, { maxAge });
}

export function buildOAuthStateCookie(
    runtime: Runtime,
    value: string,
    { maxAge = OAUTH_STATE_MAX_AGE_SECONDS }: { maxAge?: number } = {}
): string {
    return buildCookie(runtime, OAUTH_STATE_COOKIE_NAME, value, { maxAge });
}

export function clearSessionCookie(runtime: Runtime): string {
    return buildSessionCookie(runtime, '', { maxAge: 0 });
}

export function clearOAuthStateCookie(runtime: Runtime): string {
    return buildOAuthStateCookie(runtime, '', { maxAge: 0 });
}

export function verifyRequestSession(runtime: Runtime, req: Request): ReturnType<typeof verifySessionCookieValue> {
    const value = parseCookies(req)[SESSION_COOKIE_NAME];
    return verifySessionCookieValue(value || '', { secret: runtime.env.APP_SESSION_SECRET || '' });
}

export function getGoogleRedirectUri(runtime: Runtime, _req: Request): string {
    const redirectUri = resolveGoogleRedirectUri(runtime.env);
    if (!redirectUri) throw httpError(500, 'OAuth redirect URI is not configured');
    return redirectUri;
}

export function createRequireAuth(runtime: Runtime): RequestHandler {
    return (req, res, next) => {
        if (!runtime.isAuthConfigured()) {
            res.status(503).json({ error: 'Authentication is not configured' });
            return;
        }
        const session = verifyRequestSession(runtime, req);
        if (!session.ok || !session.session) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }
        req.session = session.session;
        next();
    };
}
