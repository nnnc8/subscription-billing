import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Client, type Transaction, type InStatement } from '@libsql/client';
import { openDatabase } from './database-client.js';
export { openDatabase } from './database-client.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { Database } from '../src/types/billing.js';
import { normalizeDatabaseRelations } from './accounting.js';

// Import repositories
import { SettingsRepository } from './repositories/settings.js';
import { PlatformRepository } from './repositories/platforms.js';
import { MemberRepository } from './repositories/members.js';
import { SubscriptionRepository } from './repositories/subscriptions.js';
import { PaymentRepository } from './repositories/payments.js';
import { TempChargeRepository } from './repositories/tempCharges.js';
import { HistoryRepository } from './repositories/history.js';
import { LedgerRepository } from './repositories/ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, 'migrations');

export function getCanonicalPersistedProjection(data: Database): Record<string, unknown> {
  return {
    settings: {
      currentMonth: data.currentMonth || '',
      baseMonth: data.baseMonth || '',
      bankInfo: data.bankInfo || '',
      reminderStyle: data.reminderStyle || 'friendly',
      lifecycle: data.lifecycle ?? null,
    },
    platforms: (data.platforms || []).map(platform => ({
      ...platform,
      archived: Boolean(platform.archived),
    })),
    members: data.members || [],
    subscriptions: (data.subscriptions || []).map(subscription => ({
      ...subscription,
      memberId: subscription.memberId || '',
      platformId: subscription.platformId || '',
      allowDuplicate: Boolean(subscription.allowDuplicate),
    })),
    payments: data.payments || [],
    tempCharges: data.tempCharges || [],
    history: data.history || [],
    ledger: {
      version: Number(data.ledger?.version || 1),
      entries: data.ledger?.entries || [],
      lastHash: data.ledger?.lastHash || '',
      updatedAt: data.ledger?.updatedAt || '',
    },
  };
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const canonical = sortCanonicalValue((value as Record<string, unknown>)[key]);
      if (canonical !== undefined && canonical !== '') sorted[key] = canonical;
    }
    return sorted;
  }
  return value;
}

export function getCanonicalPersistedFingerprint(data: Database): string {
  return JSON.stringify(sortCanonicalValue(getCanonicalPersistedProjection(data)));
}

/**
 * Version of the settings the bulk-replace routes overwrite (platforms, members, subscriptions,
 * bank info, reminder style). Clients echo it back so a save from a stale device is refused
 * instead of silently undoing changes made elsewhere, including month-close balance carry-over.
 */
export function getConfigVersion(data: Database): string {
  const projection = getCanonicalPersistedProjection(data);
  const settings = projection.settings as Record<string, unknown>;
  const config = sortCanonicalValue({
    platforms: projection.platforms,
    members: projection.members,
    subscriptions: projection.subscriptions,
    bankInfo: settings.bankInfo,
    reminderStyle: settings.reminderStyle,
  });
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

function parseLifecycleMetadata(value: string | undefined): Database['lifecycle'] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Database['lifecycle']
      : undefined;
  } catch {
    return undefined;
  }
}

export type DatabaseConnection = Client | Transaction;
export type DatabaseSource = string | Client;

async function withClient<T>(source: DatabaseSource, operation: (client: Client) => Promise<T>): Promise<T> {
  const client = typeof source === 'string' ? openDatabase(source) : source;
  try { return await operation(client); }
  finally { if (typeof source === 'string') client.close(); }
}

export async function withWriteTransaction<T>(client: Client, operation: (tx: Transaction) => Promise<T>): Promise<T> {
  let tx: Transaction | undefined;
  for (let attempt = 0; ; attempt++) {
    try { tx = await client.transaction('write'); break; }
    catch (error) {
      // Only retry a failed BEGIN. Never replay the mutator or an uncertain COMMIT.
      if (attempt >= 4 || !/SQLITE_BUSY/.test(String(error))) throw error;
      await delay(25 * (attempt + 1));
    }
  }
  try {
    const result = await operation(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try { await tx.rollback(); } catch { /* A closed/expired transaction is already rolled back. */ }
    throw error;
  } finally { tx.close(); }
}

/** All pending migrations share one write transaction, including the version check. */
export async function runMigrations(source: DatabaseSource, directory = migrationsDir): Promise<void> {
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.sql')).sort();
  const migrations = files.map(file => ({ version: file.replace(/\.sql$/, ''), sql: fs.readFileSync(path.join(directory, file), 'utf8') }));
  await withClient(source, client => withWriteTransaction(client, async tx => {
    await tx.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set((await tx.execute('SELECT version FROM schema_migrations')).rows.map(row => String(row.version)));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await tx.executeMultiple(migration.sql);
      await tx.execute({ sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', args: [migration.version, new Date().toISOString()] });
    }
  }));
}

export const initSQLite = runMigrations;

export async function loadFromConnection(db: DatabaseConnection): Promise<Database> {
  // Client.batch(..., read) is one consistent snapshot and one remote round trip.
  // Transaction.batch participates in the existing transaction.
  const statements = [
    'SELECT key, value FROM metadata', PlatformRepository.select, MemberRepository.select,
    SubscriptionRepository.select, PaymentRepository.select, TempChargeRepository.select,
    HistoryRepository.select, LedgerRepository.select
  ];
  const results = await ('protocol' in db ? db.batch(statements, 'read') : db.batch(statements));
  const metadataMap = SettingsRepository.decode(results[0]!.rows as unknown as Parameters<typeof SettingsRepository.decode>[0]);
  const lifecycle = parseLifecycleMetadata(metadataMap.get('lifecycle'));
  const entries = LedgerRepository.decode(results[7]!.rows as unknown as Parameters<typeof LedgerRepository.decode>[0]);
  const lastEntry = entries.at(-1);
  return normalizeDatabaseRelations({
    currentMonth: metadataMap.get('currentMonth') || '2026/05',
    baseMonth: metadataMap.get('baseMonth') || '2026/05',
    bankInfo: metadataMap.get('bankInfo') || '',
    reminderStyle: metadataMap.get('reminderStyle') || 'friendly',
    platforms: PlatformRepository.decode(results[1]!.rows as unknown as Parameters<typeof PlatformRepository.decode>[0]),
    members: MemberRepository.decode(results[2]!.rows as unknown as Parameters<typeof MemberRepository.decode>[0]),
    subscriptions: SubscriptionRepository.decode(results[3]!.rows as unknown as Parameters<typeof SubscriptionRepository.decode>[0]),
    payments: PaymentRepository.decode(results[4]!.rows as unknown as Parameters<typeof PaymentRepository.decode>[0]),
    tempCharges: TempChargeRepository.decode(results[5]!.rows as unknown as Parameters<typeof TempChargeRepository.decode>[0]),
    history: HistoryRepository.decode(results[6]!.rows as unknown as Parameters<typeof HistoryRepository.decode>[0]),
    ledger: {
      version: Number(metadataMap.get('ledgerVersion') || 1), entries,
      lastHash: metadataMap.get('ledgerLastHash') || lastEntry?.hash || '',
      updatedAt: metadataMap.get('ledgerUpdatedAt') || lastEntry?.at || ''
    },
    ...(lifecycle ? { lifecycle } : {})
  });
}

export async function loadFromSQLite(source: DatabaseSource): Promise<Database> {
  return withClient(source, loadFromConnection);
}

function metadata(data: Database): Record<string, string> {
  return {
    currentMonth: data.currentMonth || '', baseMonth: data.baseMonth || '',
    bankInfo: data.bankInfo || '', reminderStyle: data.reminderStyle || 'friendly',
    ledgerLastHash: data.ledger?.lastHash || '', ledgerUpdatedAt: data.ledger?.updatedAt || '',
    ledgerVersion: String(data.ledger?.version || 1), lifecycle: data.lifecycle ? JSON.stringify(data.lifecycle) : ''
  };
}

/** Write only changed rows; every statement stays far below SQLite's variable limit. */
export async function writeDatabase(tx: Transaction, previous: Database, next: Database): Promise<void> {
  const statements: InStatement[] = [
    ...SettingsRepository.changes(metadata(previous), metadata(next)),
    ...PlatformRepository.changes(previous.platforms, next.platforms),
    ...MemberRepository.changes(previous.members, next.members),
    ...SubscriptionRepository.changes(previous.subscriptions, next.subscriptions),
    ...PaymentRepository.changes(previous.payments, next.payments),
    ...TempChargeRepository.changes(previous.tempCharges, next.tempCharges),
    ...HistoryRepository.changes(previous.history, next.history),
    ...LedgerRepository.changes(previous.ledger.entries, next.ledger.entries)
  ];
  for (let start = 0; start < statements.length; start += 100) {
    await tx.batch(statements.slice(start, start + 100));
  }
}

export async function verifyDatabase(tx: Transaction, expected: Database): Promise<void> {
  if (getCanonicalPersistedFingerprint(await loadFromConnection(tx)) !== getCanonicalPersistedFingerprint(expected)) {
    throw new Error('SQLite canonical projection read-back mismatch');
  }
}

export async function saveToSQLite(source: DatabaseSource, data: Database): Promise<void> {
  const normalized = normalizeDatabaseRelations(data);
  await withClient(source, client => withWriteTransaction(client, async tx => {
    const previous = await loadFromConnection(tx);
    await writeDatabase(tx, previous, normalized);
    await verifyDatabase(tx, normalized);
  }));
}

export async function migrateJsonToSQLite(jsonPath: string, source: DatabaseSource): Promise<boolean> {
  if (!fs.existsSync(jsonPath)) return false;
  const data = normalizeDatabaseRelations(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
  await saveToSQLite(source, data);
  return true;
}
