import { afterEach } from 'vitest';
import type { Client } from '@libsql/client';
import * as db from '../lib/db.js';
import { createRuntime as createActualRuntime, type Runtime, type RuntimeOptions } from '../server/runtime.js';

export * from '../lib/db.js';
export * from '../server/runtime.js';
const clients: Client[] = [];
const runtimes: Runtime[] = [];
const target = (source: db.DatabaseSource) => typeof source === 'string' ? process.env.TEST_LIBSQL_URL || source : source;
export function openDatabase(source: string): Client {
    const client = db.openDatabase(String(target(source)));
    clients.push(client);
    return client;
}
export const runMigrations = (source: db.DatabaseSource, directory?: string) => db.runMigrations(target(source), directory);
export const initSQLite = runMigrations;
export const loadFromSQLite = (source: db.DatabaseSource) => db.loadFromSQLite(target(source));
export const saveToSQLite = (source: db.DatabaseSource, data: Parameters<typeof db.saveToSQLite>[1]) => db.saveToSQLite(target(source), data);
export function createRuntime(options: RuntimeOptions = {}): Runtime {
    const url = process.env.TEST_LIBSQL_URL;
    const runtime = createActualRuntime(url ? { ...options, env: { ...(options.env || process.env), TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: undefined } } : options);
    runtimes.push(runtime);
    return runtime;
}
afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.close();
    for (const client of clients.splice(0)) client.close();
});
