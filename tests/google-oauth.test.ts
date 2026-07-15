import { describe, expect, it, vi } from 'vitest';
import { exchangeGoogleCode, fetchGoogleUserinfo } from '../lib/google-oauth.js';
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
