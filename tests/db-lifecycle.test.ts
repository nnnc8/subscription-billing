import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { initSQLite, loadFromSQLite, saveToSQLite } from '../lib/db.js';
import type { Database, LifecycleMetadata } from '../src/types/billing.js';

const fixturePath = path.resolve('fixtures/demo-database.json');
const temporaryDirectories: string[] = [];

function temporaryDatabase(): { directory: string; sqlitePath: string } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-lifecycle-db-'));
    temporaryDirectories.push(directory);
    return { directory, sqlitePath: path.join(directory, 'database.db') };
}

function fixtureDatabase(): Database {
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Database;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('SQLite lifecycle metadata', () => {
    it('round-trips lifecycle timestamps and run status through one metadata key', () => {
        const { sqlitePath } = temporaryDatabase();
        initSQLite(sqlitePath);
        const db = fixtureDatabase();
        const lifecycle: LifecycleMetadata & { lastRunAt: string; lastRunStatus: string } = {
            timezone: 'Asia/Taipei',
            autoAdvanceEnabled: true,
            lastCheckedAt: '2026-07-12T00:00:00.000Z',
            lastAdvancedAt: '2026-07-01T00:00:00.000Z',
            lastAdvancedFrom: '2026/06',
            lastAdvancedTo: '2026/07',
            lastRunAt: '2026-07-12T00:00:01.000Z',
            lastRunStatus: 'current'
        };
        db.lifecycle = lifecycle;

        saveToSQLite(sqlitePath, db);
        const loaded = loadFromSQLite(sqlitePath);
        expect(loaded.lifecycle).toMatchObject({
            lastAdvancedAt: lifecycle.lastAdvancedAt,
            lastAdvancedFrom: lifecycle.lastAdvancedFrom,
            lastAdvancedTo: lifecycle.lastAdvancedTo,
            lastRunAt: lifecycle.lastRunAt,
            lastRunStatus: lifecycle.lastRunStatus
        });
    });

    it('ignores corrupt lifecycle JSON without failing the rest of the database load', () => {
        const { sqlitePath } = temporaryDatabase();
        initSQLite(sqlitePath);
        saveToSQLite(sqlitePath, fixtureDatabase());
        const sqlite = new SqliteDatabase(sqlitePath);
        try {
            sqlite.prepare("INSERT INTO metadata (key, value) VALUES ('lifecycle', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                .run('{not-json');
        } finally {
            sqlite.close();
        }

        const loaded = loadFromSQLite(sqlitePath);
        expect(loaded.currentMonth).toBe('2026/06');
        expect(loaded.lifecycle).toBeUndefined();
    });
});
