import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findAccountingWarnings } from '../lib/accounting.js';
import { initSQLite, loadFromSQLite, saveToSQLite } from '../lib/db.js';
import { createRuntime } from '../server/runtime.js';
import type { Database } from '../src/types/billing.js';

const fixturePath = path.resolve('fixtures/demo-database.json');
const temporaryDirectories: string[] = [];

function fixtureDatabase(): Database {
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Database;
}

function testRuntime(): ReturnType<typeof createRuntime> {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-domain-validation-'));
    temporaryDirectories.push(dataDir);
    const sqlitePath = path.join(dataDir, 'database.db');
    initSQLite(sqlitePath);
    saveToSQLite(sqlitePath, fixtureDatabase());
    const runtime = createRuntime({
        rootDir: path.resolve('.'),
        dataDir,
        sqlitePath,
        backupDir: path.join(dataDir, 'backups'),
        env: { NODE_ENV: 'test', MIGRATE_FROM_JSON: '0' }
    });
    runtime.initialize();
    return runtime;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('deterministic domain validation', () => {
    it('reports IDs, references, calendar dates, cycles, ordering and active duplicates', () => {
        const db = fixtureDatabase();
        db.members.push({ ...db.members[0]!, name: db.members[0]!.name });
        db.subscriptions.push({
            ...db.subscriptions[0]!,
            id: 's_bad_order',
            memberId: 'missing-member',
            startMonth: '2026/07',
            exitMonth: '2026/06',
            allowDuplicate: false
        });
        db.subscriptions.push({
            ...db.subscriptions[0]!,
            id: 's_active_duplicate',
            startMonth: '2026/06',
            allowDuplicate: false
        });
        db.payments[0]!.date = '2026-02-30';
        db.payments[0]!.cycle = '202605';

        const codes = new Set(findAccountingWarnings(db).map(warning => warning.code));
        expect([...codes]).toEqual(expect.arrayContaining([
            'duplicate_member_id',
            'duplicate_member_name',
            'orphan_subscription_member',
            'subscription_exit_before_start',
            'invalid_payment_date',
            'payment_cycle_mismatch',
            'duplicate_active_subscription'
        ]));
    });

    it('rejects a fresh-state mutation that would move payment data outside the active month', async () => {
        const runtime = testRuntime();
        const before = loadFromSQLite(runtime.paths.sqlitePath).payments[0]!.cycle;
        await expect(runtime.mutateDB(db => {
            db.payments[0]!.cycle = '202605';
        })).rejects.toThrow(/payment_cycle_mismatch/);
        expect(loadFromSQLite(runtime.paths.sqlitePath).payments[0]!.cycle).toBe(before);
    });
});
