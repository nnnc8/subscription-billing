import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SqliteDatabase from 'better-sqlite3';
import type { Database as SQLiteConnection } from 'better-sqlite3';
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

/**
 * Runs pending DDL migrations in a transaction.
 */
export function runMigrations(sqlitePath: string, migrationsDirOverride = migrationsDir): void {
  const db = new SqliteDatabase(sqlitePath);
  try {
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');

    const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>;
    const applied = new Set(appliedRows.map(r => r.version));

    if (!fs.existsSync(migrationsDirOverride)) {
      console.warn(`[migration] Migrations directory does not exist: ${migrationsDirOverride}`);
      return;
    }

    const files = fs.readdirSync(migrationsDirOverride)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;

      const sql = fs.readFileSync(path.join(migrationsDirOverride, file), 'utf8');

      const runMigration = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      });

      runMigration();
      console.log(`[migration] Applied migration: ${file}`);
    }
  } finally {
    db.close();
  }
}

/**
 * Initializes the SQLite database and runs DDL migrations.
 */
export function initSQLite(sqlitePath: string): void {
  runMigrations(sqlitePath);
}

function loadFromConnection(db: SQLiteConnection): Database {
  const metadataMap = SettingsRepository.load(db);

  const currentMonth = metadataMap.get('currentMonth') || '2026/05';
  const baseMonth = metadataMap.get('baseMonth') || '2026/05';
  const bankInfo = metadataMap.get('bankInfo') || '';
  const reminderStyle = metadataMap.get('reminderStyle') || 'friendly';
  const lifecycle = parseLifecycleMetadata(metadataMap.get('lifecycle'));

  const platforms = PlatformRepository.findAll(db);
  const members = MemberRepository.findAll(db);
  const subscriptions = SubscriptionRepository.findAll(db);
  const payments = PaymentRepository.findAll(db);
  const tempCharges = TempChargeRepository.findAll(db);
  const history = HistoryRepository.findAll(db);
  const entries = LedgerRepository.findAll(db);
  const lastEntry = entries.at(-1);

  const lastHash = metadataMap.get('ledgerLastHash') || lastEntry?.hash || '';
  const updatedAt = metadataMap.get('ledgerUpdatedAt') || lastEntry?.at || '';
  const version = Number(metadataMap.get('ledgerVersion') || '1');

  const rawDb: Database = {
    currentMonth,
    baseMonth,
    bankInfo,
    reminderStyle,
    platforms,
    members,
    subscriptions,
    payments,
    tempCharges,
    history,
    ledger: {
      version,
      entries,
      lastHash,
      updatedAt
    },
    ...(lifecycle ? { lifecycle } : {})
  };

  return normalizeDatabaseRelations(rawDb);
}

/**
 * Loads the database state from SQLite relational tables.
 */
export function loadFromSQLite(sqlitePath: string): Database {
  const db = new SqliteDatabase(sqlitePath);
  try {
    return loadFromConnection(db);
  } finally {
    db.close();
  }
}

/**
 * Saves the database state to SQLite relational tables using a clean write transaction.
 */
export function saveToSQLite(sqlitePath: string, data: Database): void {
  const db = new SqliteDatabase(sqlitePath);
  const normalizedData = normalizeDatabaseRelations(data);
  const expectedFingerprint = getCanonicalPersistedFingerprint(normalizedData);
  try {
    const runTransaction = db.transaction((dbState: Database) => {
      SettingsRepository.save(db, {
        currentMonth: dbState.currentMonth || '',
        baseMonth: dbState.baseMonth || '',
        bankInfo: dbState.bankInfo || '',
        reminderStyle: dbState.reminderStyle || '',
        ledgerLastHash: dbState.ledger?.lastHash || '',
        ledgerUpdatedAt: dbState.ledger?.updatedAt || '',
        ledgerVersion: String(dbState.ledger?.version || 1),
        lifecycle: dbState.lifecycle ? JSON.stringify(dbState.lifecycle) : '',
      });

      PlatformRepository.saveAll(db, dbState.platforms || []);
      MemberRepository.saveAll(db, dbState.members || []);
      SubscriptionRepository.saveAll(db, dbState.subscriptions || []);
      PaymentRepository.saveAll(db, dbState.payments || []);
      TempChargeRepository.saveAll(db, dbState.tempCharges || []);
      HistoryRepository.saveAll(db, dbState.history || []);
      LedgerRepository.saveAll(db, dbState.ledger?.entries || []);

      const readBack = loadFromConnection(db);
      const actualFingerprint = getCanonicalPersistedFingerprint(readBack);
      if (actualFingerprint !== expectedFingerprint) {
        throw new Error('SQLite canonical projection read-back mismatch');
      }
    });

    runTransaction(normalizedData);
  } finally {
    db.close();
  }

  // Verify the committed state again from a fresh connection.
  const writtenDb = loadFromSQLite(sqlitePath);
  if (getCanonicalPersistedFingerprint(writtenDb) !== expectedFingerprint) {
    throw new Error('SQLite committed canonical projection mismatch');
  }
}

/**
 * Backup the SQLite database file to a destination path using better-sqlite3's backup method.
 */
export async function backupSQLite(sqlitePath: string, backupPath: string): Promise<void> {
  const db = new SqliteDatabase(sqlitePath);
  try {
    await db.backup(backupPath);
  } finally {
    db.close();
  }
}

/**
 * Migrates data from JSON file into SQLite database.
 */
export function migrateJsonToSQLite(jsonPath: string, sqlitePath: string): boolean {
  try {
    if (!fs.existsSync(jsonPath)) return false;
    const jsonStr = fs.readFileSync(jsonPath, 'utf8');
    const data = normalizeDatabaseRelations(JSON.parse(jsonStr));
    saveToSQLite(sqlitePath, data);
    return true;
  } catch (err) {
    console.error('Migration to SQLite failed:', err);
    return false;
  }
}
