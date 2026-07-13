import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGoogleRedirectUri } from '../lib/google-oauth.js';
import { createApp } from '../server/app.js';
import { createTrustProxy, createRuntime } from '../server/runtime.js';

const openServers: Array<ReturnType<ReturnType<typeof createApp>['listen']>> = [];

afterEach(async () => {
    await Promise.all(openServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('HTTP trust and origin boundaries', () => {
    it('does not trust forwarded addresses by default and only trusts valid configured IPv4 CIDRs', () => {
        expect(createTrustProxy(undefined)).toBe(false);
        expect(createTrustProxy('not-a-cidr')).toBe(false);
        const trust = createTrustProxy('127.0.0.1/32, 10.0.0.0/8, ::1/128');
        expect(typeof trust).toBe('function');
        expect((trust as (ip: string) => boolean)('127.0.0.1')).toBe(true);
        expect((trust as (ip: string) => boolean)('::1')).toBe(true);
        expect((trust as (ip: string) => boolean)('192.168.1.1')).toBe(false);
    });

    it('requires a valid public origin for public authentication binding', () => {
        const env = {
            NODE_ENV: 'production',
            HOST: '0.0.0.0',
            APP_SESSION_SECRET: 'session-secret-long-enough-for-test',
            GOOGLE_CLIENT_ID: 'client',
            GOOGLE_CLIENT_SECRET: 'secret',
            GOOGLE_ALLOWED_EMAILS: 'owner@example.com'
        };
        expect(createRuntime({ env }).isAuthConfigured()).toBe(false);
        expect(createRuntime({ env: { ...env, PUBLIC_ORIGIN: 'https://billing.example' } }).isAuthConfigured()).toBe(true);
    });

    it('uses configured OAuth redirect or PUBLIC_ORIGIN, never forwarded request headers', () => {
        expect(resolveGoogleRedirectUri({
            GOOGLE_REDIRECT_URI: 'not-a-redirect',
            PUBLIC_ORIGIN: 'https://billing.example'
        })).toBe('https://billing.example/api/auth/callback');
        expect(resolveGoogleRedirectUri({
            GOOGLE_REDIRECT_URI: 'https://oauth.example/api/auth/callback',
            PUBLIC_ORIGIN: 'https://billing.example'
        })).toBe('https://oauth.example/api/auth/callback');
        expect(resolveGoogleRedirectUri({ PUBLIC_ORIGIN: 'https://billing.example/path' })).toBeNull();
    });

    it('rejects an origin authorized only by X-Forwarded headers', async () => {
        const runtime = createRuntime({
            env: {
                NODE_ENV: 'test',
                PUBLIC_ORIGIN: 'https://billing.example',
                ALLOWED_ORIGINS: 'https://allowed.example'
            }
        });
        const server = createApp({ runtime }).listen(0, '127.0.0.1');
        openServers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
        const { port } = server.address() as AddressInfo;
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
            headers: {
                Origin: 'https://spoofed.example',
                'X-Forwarded-Proto': 'https',
                'X-Forwarded-Host': 'billing.example'
            }
        });
        expect(response.status).toBe(403);
    });
});
