import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_SCOPE, buildGoogleAuthUrl, exchangeGoogleCode, fetchGoogleUserinfo, isAllowedGoogleUser } from '../lib/google-oauth.js';
import type { GoogleOAuthConfig } from '../src/types/billing.js';

const config: GoogleOAuthConfig = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    allowedEmails: new Set(['owner@example.com']),
    authUrl: 'https://accounts.example.test/auth',
    tokenUrl: 'https://accounts.example.test/token',
    userinfoUrl: 'https://accounts.example.test/userinfo',
    redirectUri: 'https://billing.example.test/api/auth/callback'
};

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

describe('Google OAuth external response validation', () => {
    it('accepts a valid token response and profile', async () => {
        const token = await exchangeGoogleCode({
            config,
            code: 'auth-code',
            redirectUri: config.redirectUri,
            fetchImpl: vi.fn(async () => response({ access_token: 'access-token', token_type: 'Bearer' })) as unknown as typeof fetch
        });
        const profile = await fetchGoogleUserinfo({
            config,
            accessToken: String(token.access_token),
            fetchImpl: vi.fn(async () => response({
                email: 'owner@example.com',
                email_verified: true,
                name: 'Owner'
            })) as unknown as typeof fetch
        });

        expect(token.access_token).toBe('access-token');
        expect(profile.email).toBe('owner@example.com');
        expect(profile.email_verified).toBe(true);
    });

    it('rejects a malformed token payload even when Google returns HTTP 200', async () => {
        await expect(exchangeGoogleCode({
            config,
            code: 'auth-code',
            redirectUri: config.redirectUri,
            fetchImpl: vi.fn(async () => response({ access_token: 42 })) as unknown as typeof fetch
        })).rejects.toMatchObject({ status: 502 });
    });

    it('rejects a malformed userinfo payload even when required fields are present', async () => {
        await expect(fetchGoogleUserinfo({
            config,
            accessToken: 'access-token',
            fetchImpl: vi.fn(async () => response({ email: 'owner@example.com', email_verified: 'true' })) as unknown as typeof fetch
        })).rejects.toMatchObject({ status: 502 });
    });
});

describe('Google sign-in redirect', () => {
    it('asks for the account chooser and never carries an allow-listed address', () => {
        const allowLists = [
            new Set(['owner@example.com']),
            new Set(['owner@example.com', 'second@example.com'])
        ];
        for (const allowedEmails of allowLists) {
            const location = buildGoogleAuthUrl({
                config: { ...config, allowedEmails },
                redirectUri: config.redirectUri,
                state: 'state-value'
            });
            const url = new URL(location);

            expect(`${url.origin}${url.pathname}`).toBe(config.authUrl);
            expect(url.searchParams.get('client_id')).toBe('client-id');
            expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
            expect(url.searchParams.get('response_type')).toBe('code');
            expect(url.searchParams.get('scope')).toBe(GOOGLE_SCOPE);
            expect(url.searchParams.get('state')).toBe('state-value');
            expect(url.searchParams.get('prompt')).toBe('select_account');
            expect(url.searchParams.has('login_hint')).toBe(false);
            for (const email of allowedEmails) {
                expect(decodeURIComponent(location)).not.toContain(email);
            }
        }
    });

    it('admits only a verified address that is on the allow-list', () => {
        const allowedEmails = new Set(['owner@example.com']);

        expect(isAllowedGoogleUser({ email: 'Owner@Example.com', email_verified: true }, allowedEmails)).toBe(true);
        expect(isAllowedGoogleUser({ email: 'owner@example.com', email_verified: false }, allowedEmails)).toBe(false);
        expect(isAllowedGoogleUser({ email: 'owner@example.com' }, allowedEmails)).toBe(false);
        expect(isAllowedGoogleUser({ email: 'other@example.com', email_verified: true }, allowedEmails)).toBe(false);
        expect(isAllowedGoogleUser({ email_verified: true }, allowedEmails)).toBe(false);
        expect(isAllowedGoogleUser(null, allowedEmails)).toBe(false);
    });
});
