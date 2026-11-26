import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { monthToCode } from '../lib/accounting.js';
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME, createSessionCookieValue } from '../lib/auth.js';
import { getSystemMonth } from '../lib/lifecycle.js';
import { createApp } from '../server/app.js';
import type { Database, Subscription } from '../src/types/billing.js';
import { MutationPersistenceError, createRuntime, getCanonicalPersistedFingerprint, type Runtime, type RuntimeOptions } from './test-database.js';
const rootDir = path.resolve('.');
const fixturePath = path.join(rootDir, 'fixtures', 'demo-database.json');
const sessionSecret = 'integration-session-secret-with-enough-length-1234567890';
const allowedEmail = 'owner@example.com';
const temporaryDirectories: string[] = [];
type Layer = {
    route?: {
        path?: unknown;
        methods?: Record<string, boolean>;
    };
    handle?: {
        stack?: Layer[];
    };
};
async function createTestRuntime(extraEnv: Record<string, string | undefined> = {}, runtimeOptions: Omit<RuntimeOptions, 'rootDir' | 'env' | 'dataDir' | 'distDir'> = {}): Promise<Runtime> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-server-integration-'));
    temporaryDirectories.push(dataDir);
    fs.copyFileSync(fixturePath, path.join(dataDir, 'database.json'));
    const distDir = path.join(dataDir, 'dist');
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>integration-spa</title>', 'utf8');
    const runtime = createRuntime({
        rootDir,
        distDir,
        ...runtimeOptions,
        env: {
            NODE_ENV: 'test',
            HOST: '127.0.0.1',
            PORT: '0',
            DATA_DIR: dataDir,
            DB_PATH: path.join(dataDir, 'database.json'),
            SQLITE_PATH: path.join(dataDir, 'database.db'),
            BACKUP_DIR: path.join(dataDir, 'backups'),
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
async function withApp<T>(runtime: Runtime, run: (baseUrl: string, cookie: string) => Promise<T>, overrides: Partial<Runtime> = {}): Promise<T> {
    const server = createApp({ runtime, overrides }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const { port } = server.address() as AddressInfo;
    const session = createSessionCookieValue({
        secret: sessionSecret,
        user: { email: allowedEmail, name: 'Owner' }
    });
    try {
        return await run(`http://127.0.0.1:${port}`, `${SESSION_COOKIE_NAME}=${session}`);
    }
    finally {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
}
function collectApiRoutes(layers: Layer[], routes: string[] = []): string[] {
    for (const layer of layers) {
        if (typeof layer.route?.path === 'string' && layer.route.path.startsWith('/api/')) {
            for (const method of Object.keys(layer.route.methods || {})) {
                routes.push(`${method.toUpperCase()} ${layer.route.path}`);
            }
        }
        if (layer.handle?.stack)
            collectApiRoutes(layer.handle.stack, routes);
    }
    return routes;
}
function routeInventory(runtime: Runtime): string[] {
    const app = createApp({ runtime }) as unknown as {
        router: {
            stack: Layer[];
        };
    };
    return collectApiRoutes(app.router.stack).sort();
}
async function json(response: Response): Promise<Record<string, unknown>> {
    return await response.json() as Record<string, unknown>;
}
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
describe('server composition and route parity', () => {
    it('keeps app/runtime construction free of filesystem bootstrap side effects', () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-server-pure-import-'));
        temporaryDirectories.push(parent);
        const dataDir = path.join(parent, 'not-created');
        const runtime = createRuntime({ rootDir, dataDir, env: { NODE_ENV: 'test' } });
        createApp({ runtime });
        expect(fs.existsSync(dataDir)).toBe(false);
    });
    it('preserves all 31 API method/path pairs', () => {
        const runtime = createRuntime({ rootDir, env: { NODE_ENV: 'test' } });
        expect(routeInventory(runtime)).toEqual([
            'DELETE /api/backups/:filename',
            'DELETE /api/member/:id',
            'DELETE /api/payment/:id',
            'DELETE /api/platform/:id',
            'DELETE /api/temp-charge/:id',
            'GET /api/audit',
            'GET /api/auth/callback',
            'GET /api/auth/login',
            'GET /api/auth/session',
            'GET /api/backups',
            'GET /api/backups/:filename/preview',
            'GET /api/close-preview',
            'GET /api/data',
            'GET /api/export-json',
            'GET /api/health',
            'GET /api/ledger',
            'GET /api/lifecycle/status',
            'POST /api/auth/logout',
            'POST /api/auth/logout-all',
            'POST /api/backups/create',
            'POST /api/backups/restore',
            'POST /api/member',
            'POST /api/payment',
            'POST /api/platform',
            'POST /api/settle',
            'POST /api/temp-charge',
            'POST /api/update-bank',
            'POST /api/update-config-bundle',
            'POST /api/update-members',
            'POST /api/update-prices',
            'POST /api/update-subscriptions'
        ].sort());
    });
});
describe('native fetch integration across route groups', () => {
    it('covers auth, data, billing, settings, lifecycle, backup, 404 and static SPA', async () => {
        const runtime = (await createTestRuntime());
        await withApp(runtime, async (baseUrl, cookie) => {
            expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
            expect((await fetch(`${baseUrl}/api/data`)).status).toBe(401);
            expect((await fetch(`${baseUrl}/api/export-json`)).status).toBe(401);
            const data = await fetch(`${baseUrl}/api/data`, { headers: { Cookie: cookie } });
            expect(data.status).toBe(200);
            expect((await json(data)).currentMonth).toBe('2026/06');
            const dbPathMtimeBeforeExport = fs.statSync(runtime.paths.dbPath).mtimeMs;
            const exported = await fetch(`${baseUrl}/api/export-json`, { headers: { Cookie: cookie } });
            expect(exported.status).toBe(200);
            expect(exported.headers.get('content-disposition')).toContain('attachment');
            expect(exported.headers.get('content-type')).toContain('application/json');
            expect(JSON.parse(await exported.text()).currentMonth).toBe('2026/06');
            expect(fs.statSync(runtime.paths.dbPath).mtimeMs).toBe(dbPathMtimeBeforeExport);
            const invalidPayment = await fetch(`${baseUrl}/api/payment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ memberId: 'm_alpha' })
            });
            expect(invalidPayment.status).toBe(400);
            const payment = await fetch(`${baseUrl}/api/payment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ memberId: 'm_alpha', amount: 123, note: 'integration-write' })
            });
            expect(payment.status).toBe(200);
            expect((await runtime.readDB())?.payments.some(item => item.note === 'integration-write')).toBe(true);
            const member = await fetch(`${baseUrl}/api/member`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ name: 'Integration Member' })
            });
            expect(member.status).toBe(200);
            expect((await fetch(`${baseUrl}/api/lifecycle/status`, { headers: { Cookie: cookie } })).status).toBe(200);
            expect((await fetch(`${baseUrl}/api/backups`, { headers: { Cookie: cookie } })).status).toBe(200);
            expect((await fetch(`${baseUrl}/api/backups/not-valid/preview`, {
                headers: { Cookie: cookie }
            })).status).toBe(400);
            // The retired AI and text-ingestion routes answer like any other unknown route.
            for (const retired of ['/api/ai/chat', '/api/ai/generate-reminder', '/api/automation/ingest']) {
                expect((await fetch(`${baseUrl}${retired}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Cookie: cookie },
                    body: JSON.stringify({})
                })).status).toBe(404);
            }
            expect((await fetch(`${baseUrl}/api/automation/inbox`, { headers: { Cookie: cookie } })).status).toBe(404);
            const unknown = await fetch(`${baseUrl}/api/not-a-route`, { headers: { Cookie: cookie } });
            expect(unknown.status).toBe(404);
            expect(unknown.headers.get('content-type')).toContain('application/json');
            expect(await json(unknown)).toEqual({ error: 'Not found' });
            const spa = await fetch(`${baseUrl}/operations`);
            expect(spa.status).toBe(200);
            expect(await spa.text()).toContain('integration-spa');
        });
    });
    it('compares complete origins and still allows configured origins', async () => {
        const runtime = (await createTestRuntime({ ALLOWED_ORIGINS: 'https://allowed.example' }));
        await withApp(runtime, async (baseUrl) => {
            const wrongScheme = await fetch(`${baseUrl}/api/health`, {
                headers: { Origin: baseUrl.replace('http:', 'https:') }
            });
            expect(wrongScheme.status).toBe(403);
            const configured = await fetch(`${baseUrl}/api/health`, {
                headers: { Origin: 'https://allowed.example' }
            });
            expect(configured.status).toBe(200);
            expect(configured.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
        });
    });
    it('gives a refused Google account a page with a way to switch, and keeps JSON for API clients', async () => {
        const refusedEmail = 'someone.else@example.com';
        const browserAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
        const google = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(req.url === '/token'
                ? { access_token: 'fake-access-token', token_type: 'Bearer' }
                : { email: refusedEmail, email_verified: true, name: 'Someone Else' }));
        });
        await new Promise<void>((resolve, reject) => {
            google.once('error', reject);
            google.listen(0, '127.0.0.1', resolve);
        });
        const googleUrl = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
        try {
            const runtime = (await createTestRuntime({
                PUBLIC_ORIGIN: 'https://billing.example',
                GOOGLE_OAUTH_TOKEN_URL: `${googleUrl}/token`,
                GOOGLE_OAUTH_USERINFO_URL: `${googleUrl}/userinfo`
            }));
            await withApp(runtime, async (baseUrl) => {
                const login = await fetch(`${baseUrl}/api/auth/login`, { redirect: 'manual' });
                expect(login.status).toBe(302);
                const location = login.headers.get('location') ?? '';
                const authUrl = new URL(location);
                expect(authUrl.searchParams.get('prompt')).toBe('select_account');
                expect(authUrl.searchParams.has('login_hint')).toBe(false);
                expect(decodeURIComponent(location)).not.toContain(allowedEmail);

                const state = authUrl.searchParams.get('state') ?? '';
                expect(state).not.toBe('');
                const stateCookie = `${OAUTH_STATE_COOKIE_NAME}=${state}`;
                const callbackUrl = `${baseUrl}/api/auth/callback?code=any-code&state=${state}`;
                const hasSessionCookie = (response: Response) => response.headers.getSetCookie()
                    .some(cookie => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));

                const refusedApi = await fetch(callbackUrl, { redirect: 'manual', headers: { Cookie: stateCookie } });
                expect(refusedApi.status).toBe(403);
                expect(hasSessionCookie(refusedApi)).toBe(false);
                expect(await json(refusedApi)).toEqual({ error: 'Google account is not allowed' });

                const refusedPage = await fetch(callbackUrl, {
                    redirect: 'manual',
                    headers: { Cookie: stateCookie, Accept: browserAccept }
                });
                expect(refusedPage.status).toBe(403);
                expect(refusedPage.headers.get('content-type')).toContain('text/html');
                expect(refusedPage.headers.get('cache-control')).toBe('no-store');
                expect(hasSessionCookie(refusedPage)).toBe(false);
                const refusedHtml = await refusedPage.text();
                expect(refusedHtml).toContain(refusedEmail);
                expect(refusedHtml).toContain('href="/api/auth/login"');
                expect(refusedHtml).not.toContain(allowedEmail);
                expect(refusedHtml).not.toContain('<script');

                const cancelledPage = await fetch(`${baseUrl}/api/auth/callback?error=access_denied&state=${state}`, {
                    redirect: 'manual',
                    headers: { Cookie: stateCookie, Accept: browserAccept }
                });
                expect(cancelledPage.status).toBe(400);
                expect(cancelledPage.headers.get('content-type')).toContain('text/html');
                expect(cancelledPage.headers.get('cache-control')).toBe('no-store');
                const cancelledHtml = await cancelledPage.text();
                expect(cancelledHtml).toContain('href="/api/auth/login"');
                expect(cancelledHtml).not.toContain(refusedEmail);
                expect(cancelledHtml).not.toContain(allowedEmail);

                const wrongStateApi = await fetch(`${baseUrl}/api/auth/callback?code=any-code&state=other`, {
                    redirect: 'manual',
                    headers: { Cookie: stateCookie }
                });
                expect(wrongStateApi.status).toBe(400);
                expect(await json(wrongStateApi)).toEqual({ error: 'Invalid OAuth state' });
            });
        }
        finally {
            google.closeAllConnections();
            await new Promise<void>(resolve => { google.close(() => resolve()); });
        }
    });
    it('uses Express 5 async rejection handling and hides internal 500 details', async () => {
        const runtime = (await createTestRuntime());
        await withApp(runtime, async (baseUrl, cookie) => {
            const response = await fetch(`${baseUrl}/api/backups/create`, {
                method: 'POST',
                headers: { Cookie: cookie }
            });
            expect(response.status).toBe(500);
            expect(await json(response)).toEqual({ error: 'Internal server error' });
        }, {
            backupDB: async () => { throw new Error('sensitive async failure'); }
        });
    });
    it('deletes the oldest backup at the retention limit', async () => {
        const runtime = (await createTestRuntime());
        await withApp(runtime, async (baseUrl, cookie) => {
            const created = await fetch(`${baseUrl}/api/backups/create`, { method: 'POST', headers: { Cookie: cookie } });
            const { filename: oldest } = await json(created) as { filename: string };
            for (let i = 0; i < 49; i += 1) {
                await runtime.client.execute({
                    sql: 'INSERT INTO backups (id,created_at,reason,fingerprint,size,snapshot_json) SELECT ?,created_at,reason,fingerprint,size,snapshot_json FROM backups WHERE id=?',
                    args: [`database_20990101_000000_${String(i).padStart(3, '0')}_aaaaaaaa.db`, oldest]
                });
            }
            const response = await fetch(`${baseUrl}/api/backups/${oldest}`, { method: 'DELETE', headers: { Cookie: cookie } });
            expect(response.status).toBe(200);
            const remaining = (await runtime.client.execute('SELECT id FROM backups')).rows.map(row => String(row.id));
            expect(remaining).toHaveLength(49);
            expect(remaining).not.toContain(oldest);
        });
    });
    it('restores a backup over HTTP after subscriptions[0] was removed', async () => {
        const runtime = (await createTestRuntime());
        await withApp(runtime, async (baseUrl, cookie) => {
            const created = await fetch(`${baseUrl}/api/backups/create`, { method: 'POST', headers: { Cookie: cookie } });
            const { filename } = await json(created) as { filename: string };
            const before = (await runtime.readDB())!;
            const headers = { 'Content-Type': 'application/json', Cookie: cookie };
            const update = await fetch(`${baseUrl}/api/update-subscriptions`, {
                method: 'POST', headers, body: JSON.stringify({ subscriptions: before.subscriptions.slice(1) })
            });
            expect(update.status).toBe(200);
            expect((await runtime.readDB())!.subscriptions.map(item => item.id)).toEqual(before.subscriptions.slice(1).map(item => item.id));
            const restore = await fetch(`${baseUrl}/api/backups/restore`, { method: 'POST', headers, body: JSON.stringify({ filename }) });
            const body = await json(restore) as { success?: boolean; data?: Database };
            expect(body).toMatchObject({ success: true });
            expect(restore.status).toBe(200);
            const persisted = (await runtime.readDB())!;
            expect(persisted.subscriptions.map(item => item.id)).toEqual(before.subscriptions.map(item => item.id));
            expect(getCanonicalPersistedFingerprint(body.data!)).toBe(getCanonicalPersistedFingerprint(persisted));
            expect(runtime.getReadiness().status).toBe('ready');
        });
    });
    it('never returns an unpersisted lifecycle catch-up state after a write failure', async () => {
        const runtime = (await createTestRuntime());
        runtime.env.NODE_ENV = 'development';
        const persisted = (await runtime.readDB())!;
        // The fixture is pinned to 2026/06, so any later wall-clock month forces a catch-up.
        // (Moving currentMonth forward instead left fixture payments in a mismatched cycle.)
        expect(monthToCode(persisted.currentMonth)!).toBeLessThan(monthToCode(getSystemMonth())!);
        await withApp(runtime, async (baseUrl, cookie) => {
            const response = await fetch(`${baseUrl}/api/data`, { headers: { Cookie: cookie } });
            expect(response.status).toBe(200);
            expect((await json(response)).currentMonth).toBe(persisted.currentMonth);
            expect((await runtime.readDB())?.currentMonth).toBe(persisted.currentMonth);
        }, { mutateDB: (async () => {
                throw new MutationPersistenceError(new Error('forced lifecycle persistence failure'));
            }) as Runtime['mutateDB'] });
    });
    it('archives a member and then a platform over HTTP', async () => {
        const runtime = (await createTestRuntime());
        await withApp(runtime, async (baseUrl, cookie) => {
            const member = await fetch(`${baseUrl}/api/member/m_alpha`, { method: 'DELETE', headers: { Cookie: cookie } });
            expect(await json(member)).toMatchObject({ success: true });
            expect(member.status).toBe(200);
            const platform = await fetch(`${baseUrl}/api/platform/p_music`, { method: 'DELETE', headers: { Cookie: cookie } });
            const platformBody = await json(platform) as unknown as { success: boolean; data: Database };
            expect(platformBody).toMatchObject({ success: true });
            expect(platform.status).toBe(200);
            const persisted = (await runtime.readDB())!;
            expect(getCanonicalPersistedFingerprint(platformBody.data)).toBe(getCanonicalPersistedFingerprint(persisted));
            expect(persisted.members.find(item => item.id === 'm_alpha')).toMatchObject({ status: 'archived', archivedMonth: '2026/06' });
            expect(persisted.platforms.find(item => item.id === 'p_music')).toMatchObject({ status: 'archived', archivedMonth: '2026/06' });
            expect(persisted.subscriptions.filter(item => item.exitMonth).map(item => [item.id, item.exitMonth]).sort()).toEqual([
                ['s_alpha_video', '2026/05'],
                ['s_beta_music', '2026/05']
            ]);
            expect(persisted.ledger.entries.slice(-2).map(entry => [entry.type, entry.entityId])).toEqual([
                ['member.archived', 'm_alpha'],
                ['platform.archived', 'p_music']
            ]);
            expect(runtime.getReadiness().status).toBe('ready');
            const again = await fetch(`${baseUrl}/api/member/m_alpha`, { method: 'DELETE', headers: { Cookie: cookie } });
            expect(again.status).toBe(409);
            expect(await json(again)).toEqual({ error: '成員已停用' });
        });
    });
    it('refuses subscriptions that would overlap from a later month, and saves marked seats and handovers', async () => {
        const runtime = (await createTestRuntime());
        await withApp(runtime, async (baseUrl, cookie) => {
            const save = (subscriptions: Subscription[]) => fetch(`${baseUrl}/api/update-subscriptions`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ subscriptions })
            });
            const before = (await runtime.readDB())!;
            const alphaVideo = before.subscriptions.find(item => item.id === 's_alpha_video')!;
            const withAlphaVideo = (change: Partial<Subscription>) => before.subscriptions.map(item => item.id === alphaVideo.id ? { ...item, ...change } : item);
            // Two months after the fixture's 2026/06; s_alpha_video has no exit month.
            const later: Subscription = { ...alphaVideo, id: 's_alpha_video_2026_08', startMonth: '2026/08' };
            const refused = await save([...before.subscriptions, later]);
            expect(refused.status).toBe(400);
            expect((await json(refused)).error).toMatch(/^訂閱未儲存：2026\/08 起.*Member Alpha 在 2026\/08 有 2 筆 Shared Video/);
            // An overlap in the open month gets the same answer instead of an internal error.
            const now = await save([...before.subscriptions, { ...later, id: 's_alpha_video_2026_06', startMonth: '2026/06' }]);
            expect(now.status).toBe(400);
            expect((await json(now)).error).toMatch(/^訂閱未儲存：2026\/06 起/);
            expect(getCanonicalPersistedFingerprint((await runtime.readDB())!)).toBe(getCanonicalPersistedFingerprint(before));
            expect(runtime.getReadiness().status).toBe('ready');

            const seats = await save([...withAlphaVideo({ allowDuplicate: true, seatLabel: 'Seat A' }), { ...later, allowDuplicate: true, seatLabel: 'Seat B' }]);
            expect(seats.status).toBe(200);
            expect((await runtime.readDB())!.subscriptions.find(item => item.id === later.id)).toMatchObject({ startMonth: '2026/08', allowDuplicate: true, seatLabel: 'Seat B' });
            const handover = await save([...withAlphaVideo({ exitMonth: '2026/07' }), later]);
            expect(handover.status).toBe(200);
            expect((await runtime.readDB())!.subscriptions.filter(item => item.memberId === 'm_alpha').map(item => [item.id, item.startMonth, item.exitMonth, Boolean(item.seatLabel)])).toEqual([
                ['s_alpha_video', '2026/01', '2026/07', false],
                ['s_alpha_video_2026_08', '2026/08', undefined, false]
            ]);
        });
    });
});
describe('runtime readiness', () => {
    it('blocks initialization and exposes health 503 after a readiness failure', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-readiness-blocked-'));
        temporaryDirectories.push(dataDir);
        const runtime = createRuntime({
            rootDir,
            dataDir,
            demoDbPath: path.join(dataDir, 'missing-demo.json'),
            env: {
                NODE_ENV: 'test',
                DATA_DIR: dataDir,
                MIGRATE_FROM_JSON: '1'
            }
        });
        await expect(runtime.initialize()).rejects.toThrow(/bootstrap migration failed/i);
        expect(runtime.getReadiness().status).toBe('blocked');
        await withApp(runtime, async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/health`);
            expect(response.status).toBe(503);
            expect(await json(response)).toMatchObject({ ok: false, readiness: 'blocked' });
        });
    });
});
