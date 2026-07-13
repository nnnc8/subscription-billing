import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSystemSnapshot, previousMonthString } from '../lib/accounting.js';
import { backupSQLite } from '../lib/db.js';
import {
    SESSION_COOKIE_NAME,
    createSessionCookieValue
} from '../lib/auth.js';
import { getSystemMonth } from '../lib/lifecycle.js';
import { createApp } from '../server/app.js';
import { MutationPersistenceError, createRuntime, type Runtime, type RuntimeOptions } from '../server/runtime.js';

const rootDir = path.resolve('.');
const fixturePath = path.join(rootDir, 'fixtures', 'demo-database.json');
const sessionSecret = 'integration-session-secret-with-enough-length-1234567890';
const allowedEmail = 'owner@example.com';
const temporaryDirectories: string[] = [];

type Layer = {
    route?: { path?: unknown; methods?: Record<string, boolean> };
    handle?: { stack?: Layer[] };
};

function createTestRuntime(
    extraEnv: Record<string, string | undefined> = {},
    runtimeOptions: Omit<RuntimeOptions, 'rootDir' | 'env' | 'dataDir' | 'distDir'> = {}
): Runtime {
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
    runtime.initialize();
    return runtime;
}

async function withApp<T>(
    runtime: Runtime,
    run: (baseUrl: string, cookie: string) => Promise<T>,
    overrides: Partial<Runtime> = {}
): Promise<T> {
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
    } finally {
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
        if (layer.handle?.stack) collectApiRoutes(layer.handle.stack, routes);
    }
    return routes;
}

function routeInventory(runtime: Runtime): string[] {
    const app = createApp({ runtime }) as unknown as { router: { stack: Layer[] } };
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

    it('preserves all 38 API method/path pairs', () => {
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
            'GET /api/automation/inbox',
            'GET /api/backups',
            'GET /api/backups/:filename/preview',
            'GET /api/close-preview',
            'GET /api/data',
            'GET /api/export-json',
            'GET /api/health',
            'GET /api/ledger',
            'GET /api/lifecycle/status',
            'POST /api/ai/chat',
            'POST /api/ai/chat-legacy',
            'POST /api/ai/generate-reminder',
            'POST /api/ai/rag-search',
            'POST /api/auth/logout',
            'POST /api/automation/confirm/:id',
            'POST /api/automation/ingest',
            'POST /api/automation/reject/:id',
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
    it('covers auth, data, billing, settings, lifecycle, backup, AI, 404 and static SPA', async () => {
        const runtime = createTestRuntime();
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
            expect(runtime.readDB()?.payments.some(item => item.note === 'integration-write')).toBe(true);

            const member = await fetch(`${baseUrl}/api/member`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ name: 'Integration Member' })
            });
            expect(member.status).toBe(200);

            expect((await fetch(`${baseUrl}/api/lifecycle/status`, { headers: { Cookie: cookie } })).status).toBe(200);
            expect((await fetch(`${baseUrl}/api/backups`, { headers: { Cookie: cookie } })).status).toBe(200);
            expect((await fetch(`${baseUrl}/api/ai/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ message: '', history: [] })
            })).status).toBe(400);
            expect((await fetch(`${baseUrl}/api/ai/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ message: 'hello', history: 'not-an-array' })
            })).status).toBe(400);
            expect((await fetch(`${baseUrl}/api/ai/rag-search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ query: 'balance', topK: 0 })
            })).status).toBe(400);
            expect((await fetch(`${baseUrl}/api/backups/not-valid/preview`, {
                headers: { Cookie: cookie }
            })).status).toBe(400);
            expect((await fetch(`${baseUrl}/api/automation/inbox`, { headers: { Cookie: cookie } })).status).toBe(200);

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
        const runtime = createTestRuntime({ ALLOWED_ORIGINS: 'https://allowed.example' });
        await withApp(runtime, async baseUrl => {
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

    it('uses Express 5 async rejection handling and hides internal 500 details', async () => {
        const runtime = createTestRuntime();
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

    it('never returns an unpersisted lifecycle catch-up state after a write failure', async () => {
        const runtime = createTestRuntime({ NODE_ENV: 'development' });
        const persisted = runtime.readDB()!;
        persisted.currentMonth = previousMonthString(getSystemMonth())!;
        await runtime.mutateDB(db => {
            db.currentMonth = persisted.currentMonth;
        });

        await withApp(runtime, async (baseUrl, cookie) => {
            const response = await fetch(`${baseUrl}/api/data`, { headers: { Cookie: cookie } });
            expect(response.status).toBe(200);
            expect((await json(response)).currentMonth).toBe(persisted.currentMonth);
            expect(runtime.readDB()?.currentMonth).toBe(persisted.currentMonth);
        }, { mutateDB: (async () => {
            throw new MutationPersistenceError(new Error('forced lifecycle persistence failure'));
        }) as Runtime['mutateDB'] });
    });
});

describe('restore rollback at retention boundary', () => {
    it('keeps a non-rotated safety snapshot while restoring the oldest of MAX_BACKUPS', async () => {
        let failRestore = false;
        let restoreBackupCalls = 0;
        const runtime = createTestRuntime({}, {
            onlineBackup: async (sourcePath, destinationPath) => {
                if (failRestore) {
                    restoreBackupCalls += 1;
                    if (restoreBackupCalls === 3) throw new Error('forced stage-to-live restore failure');
                }
                await backupSQLite(sourcePath, destinationPath);
            }
        });
        const initialBackup = await runtime.backupDB();
        expect(initialBackup).toBeTruthy();
        const oldestFilename = 'database_20000101_000000_000_deadbeef.db';
        const oldestPath = path.join(runtime.paths.backupDir, oldestFilename);
        fs.renameSync(initialBackup!, oldestPath);

        const changedDb = runtime.readDB()!;
        changedDb.payments.push({
            id: 'pay_after_oldest_snapshot',
            memberId: 'm_alpha',
            memberName: 'Member Alpha',
            date: '2026-07-12',
            amount: 456,
            method: 'test',
            cycle: '202606',
            note: 'must-survive-failed-restore'
        });
        await runtime.mutateDB(db => {
            db.payments = changedDb.payments;
        });

        let regularFiles = fs.readdirSync(runtime.paths.backupDir)
            .filter(name => name.startsWith('database_') && name.endsWith('.db'));
        for (let index = regularFiles.length; index < runtime.config.maxBackups; index += 1) {
            const filename = `database_20990101_000000_${String(index).padStart(3, '0')}_aaaaaaaa.db`;
            fs.copyFileSync(oldestPath, path.join(runtime.paths.backupDir, filename));
        }
        regularFiles = fs.readdirSync(runtime.paths.backupDir)
            .filter(name => name.startsWith('database_') && name.endsWith('.db'))
            .sort();
        expect(regularFiles).toHaveLength(runtime.config.maxBackups);
        expect(regularFiles[0]).toBe(oldestFilename);

        const before = getSystemSnapshot(runtime.readDB()!);
        failRestore = true;
        await withApp(runtime, async (baseUrl, cookie) => {
            const response = await fetch(`${baseUrl}/api/backups/restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: JSON.stringify({ filename: oldestFilename })
            });
            expect(response.status).toBe(500);
            expect(await json(response)).toEqual({ error: 'Internal server error' });
        });

        const afterDb = runtime.readDB()!;
        expect(getSystemSnapshot(afterDb).fingerprint).toBe(before.fingerprint);
        expect(afterDb.payments.some(item => item.note === 'must-survive-failed-restore')).toBe(true);
        expect(fs.existsSync(oldestPath)).toBe(true);
        expect(fs.readdirSync(runtime.paths.backupDir)
            .filter(name => name.startsWith('database_') && name.endsWith('.db')))
            .toHaveLength(runtime.config.maxBackups);
        expect(fs.readdirSync(runtime.paths.backupDir).some(name => name.startsWith('.restore-safety-'))).toBe(false);
        const inventory = runtime.listBackupInventory(afterDb) as { backups: Array<{ filename: string }> };
        expect(inventory.backups).toHaveLength(runtime.config.maxBackups);
        expect(inventory.backups.every(item => item.filename.startsWith('database_'))).toBe(true);
    });
});

describe('backup delete tombstones', () => {
    it('restores a tombstone on ledger failure and clears cleanup-pending tombstones on restart', async () => {
        const runtime = createTestRuntime();
        const failedDeleteBackup = await runtime.backupDB();
        expect(failedDeleteBackup).toBeTruthy();
        const failedDeleteFilename = path.basename(failedDeleteBackup!);

        await withApp(runtime, async (baseUrl, cookie) => {
            const response = await fetch(`${baseUrl}/api/backups/${failedDeleteFilename}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: '{}'
            });
            expect(response.status).toBe(500);
            expect(await json(response)).toEqual({ error: 'Internal server error' });
        }, {
            mutateDB: (async () => {
                throw new Error('forced backup delete ledger failure');
            }) as Runtime['mutateDB']
        });

        expect(fs.existsSync(failedDeleteBackup!)).toBe(true);
        expect(fs.readdirSync(runtime.paths.backupDir).some(name => name.startsWith('.backup-tombstone-'))).toBe(false);

        const pendingBackup = await runtime.backupDB();
        expect(pendingBackup).toBeTruthy();
        const pendingFilename = path.basename(pendingBackup!);
        await withApp(runtime, async (baseUrl, cookie) => {
            const response = await fetch(`${baseUrl}/api/backups/${pendingFilename}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', Cookie: cookie },
                body: '{}'
            });
            expect(response.status).toBe(200);
            expect(await json(response)).toMatchObject({ cleanupPending: true });
        }, {
            removeBackupTombstone: () => {
                throw new Error('forced cleanup failure');
            }
        });

        expect(fs.readdirSync(runtime.paths.backupDir).some(name => name.startsWith('.backup-tombstone-'))).toBe(true);
        const restarted = createRuntime({
            rootDir,
            dataDir: runtime.paths.dataDir,
            sqlitePath: runtime.paths.sqlitePath,
            backupDir: runtime.paths.backupDir,
            env: { NODE_ENV: 'test', MIGRATE_FROM_JSON: '0' }
        });
        await restarted.initializeAtomic();
        expect(fs.readdirSync(runtime.paths.backupDir).some(name => name.startsWith('.backup-tombstone-'))).toBe(false);
        expect(fs.existsSync(pendingBackup!)).toBe(false);
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
        expect(() => runtime.initialize()).toThrow(/bootstrap source not found/i);
        expect(runtime.getReadiness().status).toBe('blocked');

        await withApp(runtime, async baseUrl => {
            const response = await fetch(`${baseUrl}/api/health`);
            expect(response.status).toBe(503);
            expect(await json(response)).toMatchObject({ ok: false, readiness: 'blocked' });
        });
    });
});
