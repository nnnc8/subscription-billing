import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME, createSessionCookieValue } from '../lib/auth.js';
import { createApp } from '../server/app.js';
import { createRuntime, type Runtime } from './test-database.js';
import { selectBackupsToPrune } from '../server/services/backup.js';
import type { Database } from '../src/types/billing.js';
const rootDir = path.resolve('.');
const fixturePath = path.join(rootDir, 'fixtures', 'demo-database.json');
const sessionSecret = 'hardening-session-secret-with-enough-length-1234567890';
const allowedEmail = 'owner@example.com';
const temporaryDirectories: string[] = [];
async function createTestRuntime(extraEnv: Record<string, string | undefined> = {}, dataDir?: string): Promise<Runtime> {
    const directory = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'billing-hardening-'));
    if (!dataDir) {
        temporaryDirectories.push(directory);
        fs.copyFileSync(fixturePath, path.join(directory, 'database.json'));
        fs.mkdirSync(path.join(directory, 'dist'));
        fs.writeFileSync(path.join(directory, 'dist', 'index.html'), '<!doctype html><title>spa</title>', 'utf8');
    }
    const runtime = createRuntime({
        rootDir,
        distDir: path.join(directory, 'dist'),
        env: {
            NODE_ENV: 'test',
            HOST: '127.0.0.1',
            PORT: '0',
            DATA_DIR: directory,
            DB_PATH: path.join(directory, 'database.json'),
            MIGRATE_FROM_JSON: '1',
            APP_SESSION_SECRET: sessionSecret,
            GOOGLE_CLIENT_ID: 'test-client',
            GOOGLE_CLIENT_SECRET: 'test-secret',
            GOOGLE_ALLOWED_EMAILS: allowedEmail,
            ...extraEnv
        }
    });
    (await runtime.initialize());
    return runtime;
}
function sessionCookie(email = allowedEmail): string {
    const value = createSessionCookieValue({ secret: sessionSecret, user: { email, name: 'Owner' } });
    return `${SESSION_COOKIE_NAME}=${value}`;
}
async function withApp<T>(runtime: Runtime, run: (baseUrl: string) => Promise<T>): Promise<T> {
    const server = createApp({ runtime }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const { port } = server.address() as AddressInfo;
    try {
        return await run(`http://127.0.0.1:${port}`);
    }
    finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}
function postJson(url: string, cookie: string, body: unknown): Promise<Response> {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body)
    });
}
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
describe('backup retention', () => {
    it('keeps recent, daily and monthly snapshots instead of only the latest writes', () => {
        const files = [
            'database_20261023_100004_000_aaaaaaaa.db',
            'database_20261023_100003_000_aaaaaaaa.db',
            'database_20261023_100002_000_aaaaaaaa.db',
            'database_20261023_100001_000_aaaaaaaa.db',
            'database_20261023_100000_000_aaaaaaaa.db',
            'database_20261022_090000_000_aaaaaaaa.db',
            'database_20261022_080000_000_aaaaaaaa.db',
            'database_20261021_090000_000_aaaaaaaa.db',
            'database_20261015_090000_000_aaaaaaaa.db',
            'database_20260920_090000_000_aaaaaaaa.db',
            'database_20260905_090000_000_aaaaaaaa.db',
            'database_20260810_090000_000_aaaaaaaa.db',
            'database_20250101_000000_000_aaaaaaaa.db',
            'notes.txt',
            'database_unexpected.db',
            '.restore-safety-1234.db'
        ];
        expect(selectBackupsToPrune(files, { keepRecent: 3, keepDaily: 3, keepMonthly: 3 })).toEqual([
            'database_20261023_100001_000_aaaaaaaa.db',
            'database_20261023_100000_000_aaaaaaaa.db',
            'database_20261022_080000_000_aaaaaaaa.db',
            'database_20261015_090000_000_aaaaaaaa.db',
            'database_20260905_090000_000_aaaaaaaa.db',
            'database_20250101_000000_000_aaaaaaaa.db'
        ]);
    });
    it('keeps an older daily backup when a burst of writes exceeds the recent limit', async () => {
        const runtime = (await createTestRuntime());
        const olderDay = 'database_20260101_120000_000_bbbbbbbb.db';
        const original = await runtime.backupDB();
        await runtime.client.execute({ sql: 'UPDATE backups SET id=? WHERE id=?', args: [olderDay, original] });
        for (let index = 0; index < runtime.config.maxBackups + 5; index += 1) {
            expect(await runtime.backupDB()).toBeTruthy();
        }
        const regular = (await runtime.client.execute('SELECT id FROM backups')).rows.map(row => String(row.id));
        expect(regular).toContain(olderDay);
        expect(regular.length).toBeLessThanOrEqual(runtime.config.maxBackups + 2);
    });
});
describe('session revocation', () => {
    it('signs out every device and keeps the cutoff across restarts', async () => {
        const runtime = (await createTestRuntime());
        const oldCookie = sessionCookie();
        await withApp(runtime, async (baseUrl) => {
            expect((await fetch(`${baseUrl}/api/data`, { headers: { Cookie: oldCookie } })).status).toBe(200);
            const response = await fetch(`${baseUrl}/api/auth/logout-all`, { method: 'POST', headers: { Cookie: oldCookie } });
            expect(response.status).toBe(200);
            expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=;`);
            expect((await fetch(`${baseUrl}/api/data`, { headers: { Cookie: oldCookie } })).status).toBe(401);
            const session = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: oldCookie } });
            expect(await session.json()).toMatchObject({ authenticated: false });
            expect((await fetch(`${baseUrl}/api/data`, { headers: { Cookie: sessionCookie() } })).status).toBe(200);
        });
        const restarted = (await createTestRuntime({}, runtime.paths.dataDir));
        expect((await restarted.sessionsRevokedBefore())).toBe((await runtime.sessionsRevokedBefore()));
        expect((await restarted.sessionsRevokedBefore())).toBeGreaterThan(0);
    });
    it('rejects logout-all without a valid session', async () => {
        const runtime = (await createTestRuntime());
        await withApp(runtime, async (baseUrl) => {
            expect((await fetch(`${baseUrl}/api/auth/logout-all`, { method: 'POST' })).status).toBe(401);
        });
        expect((await runtime.sessionsRevokedBefore())).toBe(0);
    });
    it('locks out an email removed from the allowlist even with a signed cookie', async () => {
        const runtime = (await createTestRuntime({ GOOGLE_ALLOWED_EMAILS: 'someone-else@example.com' }));
        await withApp(runtime, async (baseUrl) => {
            expect((await fetch(`${baseUrl}/api/data`, { headers: { Cookie: sessionCookie() } })).status).toBe(401);
            const allowed = await fetch(`${baseUrl}/api/data`, { headers: { Cookie: sessionCookie('someone-else@example.com') } });
            expect(allowed.status).toBe(200);
        });
    });
});
describe('multi-device config conflicts', () => {
    it('refuses a bulk save based on settings another device already changed', async () => {
        const runtime = (await createTestRuntime());
        const cookie = sessionCookie();
        await withApp(runtime, async (baseUrl) => {
            const loaded = await (await fetch(`${baseUrl}/api/data`, { headers: { Cookie: cookie } })).json() as Database;
            const staleVersion = loaded._audit?.configVersion;
            expect(staleVersion).toMatch(/^[a-f0-9]{16}$/);
            expect(loaded.subscriptions.length).toBeGreaterThan(1);
            const [, ...withoutFirst] = loaded.subscriptions;
            const first = await postJson(`${baseUrl}/api/update-subscriptions`, cookie, {
                subscriptions: withoutFirst,
                baseVersion: staleVersion
            });
            expect(first.status).toBe(200);
            const afterFirst = (await runtime.readDB())!.subscriptions.length;
            const stale = await postJson(`${baseUrl}/api/update-subscriptions`, cookie, {
                subscriptions: loaded.subscriptions,
                baseVersion: staleVersion
            });
            expect(stale.status).toBe(409);
            expect(await stale.json()).toEqual({ error: '資料已在其他裝置更新，請重新整理後再儲存' });
            expect((await runtime.readDB())!.subscriptions.length).toBe(afterFirst);
            const staleBundle = await postJson(`${baseUrl}/api/update-config-bundle`, cookie, {
                platforms: loaded.platforms,
                members: loaded.members,
                bankInfo: 'changed from a stale tab',
                reminderStyle: loaded.reminderStyle,
                baseVersion: staleVersion
            });
            expect(staleBundle.status).toBe(409);
            expect((await runtime.readDB())!.bankInfo).toBe(loaded.bankInfo);
        });
    });
    it('accepts a save carrying the current version, and older clients without one', async () => {
        const runtime = (await createTestRuntime());
        const cookie = sessionCookie();
        await withApp(runtime, async (baseUrl) => {
            const loaded = await (await fetch(`${baseUrl}/api/data`, { headers: { Cookie: cookie } })).json() as Database;
            const current = await postJson(`${baseUrl}/api/update-bank`, cookie, {
                bankInfo: 'current-version save',
                reminderStyle: loaded.reminderStyle,
                baseVersion: loaded._audit?.configVersion
            });
            expect(current.status).toBe(200);
            const legacy = await postJson(`${baseUrl}/api/update-bank`, cookie, {
                bankInfo: 'legacy save',
                reminderStyle: loaded.reminderStyle
            });
            expect(legacy.status).toBe(200);
            expect((await runtime.readDB())!.bankInfo).toBe('legacy save');
        });
    });
});
describe('public deployment hardening', () => {
    it('sends security headers and hides operational health details from anonymous callers', async () => {
        const runtime = (await createTestRuntime());
        await withApp(runtime, async (baseUrl) => {
            const anonymous = await fetch(`${baseUrl}/api/health`);
            expect(anonymous.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
            expect(anonymous.headers.get('x-frame-options')).toBe('DENY');
            expect(anonymous.headers.get('x-content-type-options')).toBe('nosniff');
            expect(anonymous.headers.get('x-powered-by')).toBeNull();
            expect(anonymous.headers.get('strict-transport-security')).toBeNull();
            expect(await anonymous.json()).toEqual({ ok: true, authConfigured: true, readiness: 'ready' });
            const operator = await fetch(`${baseUrl}/api/health`, { headers: { Cookie: sessionCookie() } });
            expect(await operator.json()).toMatchObject({ ok: true, host: '127.0.0.1', dataWritable: true });
        });
    });
    it('enables HSTS when cookies are marked secure', async () => {
        const runtime = (await createTestRuntime({ COOKIE_SECURE: 'true' }));
        await withApp(runtime, async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/health`);
            expect(response.headers.get('strict-transport-security')).toBe('max-age=15552000');
        });
    });
    it('rate limits the login endpoint per client address from the configured proxy header', async () => {
        const runtime = (await createTestRuntime({ CLIENT_IP_HEADER: 'fly-client-ip', PUBLIC_ORIGIN: 'https://billing.example' }));
        await withApp(runtime, async (baseUrl) => {
            const login = (address: string) => fetch(`${baseUrl}/api/auth/login`, {
                redirect: 'manual',
                headers: { 'Fly-Client-IP': address }
            });
            for (let attempt = 0; attempt < 30; attempt += 1) {
                expect((await login('203.0.113.7')).status).toBe(302);
            }
            const limited = await login('203.0.113.7');
            expect(limited.status).toBe(429);
            expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
            expect((await login('198.51.100.9')).status).toBe(302);
        });
    });
    it('rate limits AI endpoints per signed-in account', async () => {
        const runtime = (await createTestRuntime());
        const cookie = sessionCookie();
        await withApp(runtime, async (baseUrl) => {
            // An empty query fails validation, so no Gemini request is made, but it still counts.
            for (let attempt = 0; attempt < 30; attempt += 1) {
                expect((await postJson(`${baseUrl}/api/ai/rag-search`, cookie, { query: '' })).status).toBe(400);
            }
            const limited = await postJson(`${baseUrl}/api/ai/rag-search`, cookie, { query: '' });
            expect(limited.status).toBe(429);
            expect((await fetch(`${baseUrl}/api/data`, { headers: { Cookie: cookie } })).status).toBe(200);
        });
    });
});
