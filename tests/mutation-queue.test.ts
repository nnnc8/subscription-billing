import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { getCanonicalPersistedFingerprint, loadFromSQLite, saveToSQLite } from '../lib/db.js';
import { SESSION_COOKIE_NAME, createSessionCookieValue } from '../lib/auth.js';
import type { AutomationProposal, Database } from '../src/types/billing.js';
import { createApp } from '../server/app.js';
import { createRuntime, type Runtime } from '../server/runtime.js';

const rootDir = path.resolve('.');
const fixturePath = path.join(rootDir, 'fixtures', 'demo-database.json');
const sessionSecret = 'mutation-queue-session-secret-with-enough-length-1234567890';
const allowedEmail = 'owner@example.com';
const temporaryDirectories: string[] = [];

function createTestRuntime(): Runtime {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-mutation-queue-'));
    temporaryDirectories.push(dataDir);
    fs.copyFileSync(fixturePath, path.join(dataDir, 'database.json'));
    const distDir = path.join(dataDir, 'dist');
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>mutation-queue</title>', 'utf8');
    const runtime = createRuntime({
        rootDir,
        distDir,
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
            GOOGLE_ALLOWED_EMAILS: allowedEmail
        }
    });
    runtime.initialize();
    return runtime;
}

async function withApp<T>(runtime: Runtime, run: (baseUrl: string, cookie: string) => Promise<T>): Promise<T> {
    const server = createApp({ runtime }).listen(0, '127.0.0.1');
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

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('durable billing mutation queue', () => {
    it('preserves concurrent payment and temp-charge routes with one ledger event each', async () => {
        const runtime = createTestRuntime();
        await withApp(runtime, async (baseUrl, cookie) => {
            const headers = { 'Content-Type': 'application/json', Cookie: cookie };
            const [paymentA, paymentB] = await Promise.all([
                fetch(`${baseUrl}/api/payment`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ memberId: 'm_alpha', amount: 111, note: 'queue-a' })
                }),
                fetch(`${baseUrl}/api/payment`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ memberId: 'm_alpha', amount: 222, note: 'queue-b' })
                })
            ]);
            expect([paymentA.status, paymentB.status].sort()).toEqual([200, 200]);

            const [chargeA, chargeB] = await Promise.all([
                fetch(`${baseUrl}/api/temp-charge`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ memberId: 'm_alpha', amount: 13, desc: 'queue-c' })
                }),
                fetch(`${baseUrl}/api/temp-charge`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ memberId: 'm_alpha', amount: 17, desc: 'queue-d' })
                })
            ]);
            expect([chargeA.status, chargeB.status].sort()).toEqual([200, 200]);
        });

        const db = runtime.readDB()!;
        const payments = db.payments.filter(item => item.note === 'queue-a' || item.note === 'queue-b');
        const tempCharges = db.tempCharges.filter(item => item.desc === 'queue-c' || item.desc === 'queue-d');
        expect(payments).toHaveLength(2);
        expect(tempCharges).toHaveLength(2);
        expect(db.ledger.entries.filter(item => payments.some(payment => payment.id === item.entityId))).toHaveLength(2);
        expect(db.ledger.entries.filter(item => tempCharges.some(charge => charge.id === item.entityId))).toHaveLength(2);
    });

    it('routes settings, automation confirmation and settlement through fresh state', async () => {
        const runtime = createTestRuntime();
        await withApp(runtime, async (baseUrl, cookie) => {
            const headers = { 'Content-Type': 'application/json', Cookie: cookie };
            const state = runtime.readDB()!;
            const post = (endpoint: string, body: unknown) => fetch(`${baseUrl}${endpoint}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            expect((await post('/api/update-prices', {
                platforms: state.platforms.map(platform => ({
                    id: platform.id,
                    name: platform.name,
                    billingMode: platform.billingMode,
                    price: platform.price,
                    totalCost: platform.totalCost
                }))
            })).status).toBe(200);
            expect((await post('/api/update-members', {
                members: state.members.map(member => ({
                    id: member.id,
                    name: member.name,
                    priorBalance: member.priorBalance,
                    customFee: member.customFee
                }))
            })).status).toBe(200);
            expect((await post('/api/update-subscriptions', {
                subscriptions: state.subscriptions.map(subscription => ({
                    id: subscription.id,
                    memberId: subscription.memberId,
                    platformId: subscription.platformId,
                    memberName: subscription.memberName,
                    platformName: subscription.platformName,
                    startMonth: subscription.startMonth,
                    ...(subscription.exitMonth ? { exitMonth: subscription.exitMonth } : {}),
                    ...(subscription.seatLabel ? { seatLabel: subscription.seatLabel } : {}),
                    allowDuplicate: subscription.allowDuplicate
                }))
            })).status).toBe(200);
            expect((await post('/api/update-bank', {
                bankInfo: 'queue bank',
                reminderStyle: 'formal'
            })).status).toBe(200);
            expect((await post('/api/update-config-bundle', {
                platforms: state.platforms,
                members: state.members,
                bankInfo: 'bundle bank',
                reminderStyle: 'friendly'
            })).status).toBe(200);

            const proposal: AutomationProposal = {
                id: 'queue-confirm-proposal',
                kind: 'payment',
                sourceText: 'Member Alpha paid 333',
                confidence: 1,
                reason: 'test proposal',
                warnings: [],
                payload: {
                    memberId: 'm_alpha',
                    amount: 333,
                    date: '2026-06-20',
                    method: 'test',
                    cycle: '202606',
                    note: 'queue-confirm'
                },
                status: 'pending',
                createdAt: new Date().toISOString()
            };
            runtime.automationInbox.push(proposal);
            expect((await post('/api/automation/confirm/queue-confirm-proposal', {})).status).toBe(200);
            expect((await post('/api/settle', {})).status).toBe(200);
        });

        const db = runtime.readDB()!;
        expect(db.currentMonth).toBe('2026/07');
        expect(db.history.some(entry => entry.month === '2026/06')).toBe(true);
        expect(db.payments).toHaveLength(0);
        expect(db.ledger.entries.some(entry => entry.type === 'month.settled')).toBe(true);
    });

    it('rejects a failed item without poisoning the next queued mutation', async () => {
        const runtime = createTestRuntime();
        await expect(runtime.mutateDB(() => {
            throw new Error('forced queue failure');
        })).rejects.toThrow('forced queue failure');

        const result = await runtime.mutateDB(db => {
            db.bankInfo = 'queue-recovery';
            return 'recovered';
        });
        expect(result.value).toBe('recovered');
        expect(runtime.readDB()?.bankInfo).toBe('queue-recovery');
    });

    it('rejects Promise-like mutators before backup and write', async () => {
        const runtime = createTestRuntime();
        const beforeBackups = fs.readdirSync(runtime.paths.backupDir);
        await expect(runtime.mutateDB(() => Promise.resolve('not-allowed'))).rejects.toThrow('synchronous');
        expect(fs.readdirSync(runtime.paths.backupDir)).toEqual(beforeBackups);
    });

    it('keeps the SQLite fingerprint unchanged after a forced transaction fault', () => {
        const runtime = createTestRuntime();
        const before = getCanonicalPersistedFingerprint(runtime.readDB()!);
        const broken = JSON.parse(JSON.stringify(loadFromSQLite(runtime.paths.sqlitePath))) as Database;
        broken.members.push({ ...broken.members[0]!, id: 'broken-member', name: null as unknown as string });

        expect(() => saveToSQLite(runtime.paths.sqlitePath, broken)).toThrow();
        expect(getCanonicalPersistedFingerprint(runtime.readDB()!)).toBe(before);
    });
});
