import type { GoogleOAuthConfig } from '../src/types/billing.js';

const DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export const GOOGLE_SCOPE = 'openid email profile';

export function normalizeOrigin(value: string | undefined): string | null {
    try {
        const url = new URL(String(value || '').trim());
        if (!['http:', 'https:'].includes(url.protocol)
            || url.pathname !== '/'
            || url.search
            || url.hash
            || url.username
            || url.password) return null;
        return url.origin;
    } catch {
        return null;
    }
}

export function getPublicOrigin(env: Record<string, string | undefined> = process.env): string | null {
    return normalizeOrigin(env.PUBLIC_ORIGIN);
}

export function isValidGoogleRedirectUri(value: string | undefined): boolean {
    try {
        const url = new URL(String(value || '').trim());
        return ['http:', 'https:'].includes(url.protocol)
            && url.pathname === '/api/auth/callback'
            && !url.search
            && !url.hash
            && !url.username
            && !url.password;
    } catch {
        return false;
    }
}

export function resolveGoogleRedirectUri(env: Record<string, string | undefined> = process.env): string | null {
    const configured = String(env.GOOGLE_REDIRECT_URI || '').trim();
    if (isValidGoogleRedirectUri(configured)) return configured;
    const origin = getPublicOrigin(env);
    return origin ? `${origin}/api/auth/callback` : null;
}

function parseAllowedEmails(value: string | undefined): Set<string> {
    return new Set(String(value || '')
        .split(',')
        .map(email => email.trim().toLowerCase())
        .filter(Boolean));
}

export function getGoogleOAuthConfig(env: Record<string, string | undefined> = process.env): GoogleOAuthConfig {
    return {
        clientId: env.GOOGLE_CLIENT_ID || '',
        clientSecret: env.GOOGLE_CLIENT_SECRET || '',
        allowedEmails: parseAllowedEmails(env.GOOGLE_ALLOWED_EMAILS),
        authUrl: env.GOOGLE_OAUTH_AUTH_URL || DEFAULT_AUTH_URL,
        tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL,
        userinfoUrl: env.GOOGLE_OAUTH_USERINFO_URL || DEFAULT_USERINFO_URL,
        redirectUri: env.GOOGLE_REDIRECT_URI || ''
    };
}

export function isGoogleOAuthConfigured(env: Record<string, string | undefined> = process.env): boolean {
    const config = getGoogleOAuthConfig(env);
    return Boolean(config.clientId && config.clientSecret && config.allowedEmails.size > 0);
}

export function buildGoogleAuthUrl({ config, redirectUri, state }: { config: GoogleOAuthConfig; redirectUri: string; state: string }): string {
    const url = new URL(config.authUrl);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'online');
    if (config.allowedEmails.size === 1) {
        const [allowedEmail] = config.allowedEmails;
        if (allowedEmail) url.searchParams.set('login_hint', allowedEmail);
    } else {
        url.searchParams.set('prompt', 'select_account');
    }
    return url.toString();
}

export function isAllowedGoogleUser(profile: Record<string, unknown> | null | undefined, allowedEmails: Set<string>): boolean {
    const email = typeof profile?.email === 'string' ? profile.email.toLowerCase() : '';
    return Boolean(email && profile?.email_verified === true && allowedEmails.has(email));
}

export async function exchangeGoogleCode({ config, code, redirectUri, fetchImpl = fetch }: { config: GoogleOAuthConfig; code: string; redirectUri: string; fetchImpl?: typeof fetch }): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
    });

    const res = await fetchImpl(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const payload: Record<string, unknown> = await res.json().catch(() => ({}));
    if (!res.ok || !payload.access_token) {
        const err = new Error('Google token exchange failed');
        (err as Error & { status: number }).status = 502;
        throw err;
    }
    return payload;
}

export async function fetchGoogleUserinfo({ config, accessToken, fetchImpl = fetch }: { config: GoogleOAuthConfig; accessToken: string; fetchImpl?: typeof fetch }): Promise<Record<string, unknown>> {
    const res = await fetchImpl(config.userinfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const payload: Record<string, unknown> = await res.json().catch(() => ({}));
    if (!res.ok || !payload.email) {
        const err = new Error('Google userinfo fetch failed');
        (err as Error & { status: number }).status = 502;
        throw err;
    }
    return payload;
}
