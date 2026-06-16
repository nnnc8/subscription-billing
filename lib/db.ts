import fs from 'node:fs';
import SqliteDatabase from 'better-sqlite3';
import type { Database, Platform, Member, Subscription, Payment, TempCharge, HistoryEntry, LedgerEvent } from '../src/types/billing.js';
import { normalizeDatabaseRelations } from './accounting.js';

/**
 * Initializes the SQLite database schemas if they do not exist.
 */
export function initSQLite(sqlitePath: string): void {
  const db = new SqliteDatabase(sqlitePath);

  // Enable WAL mode for better concurrency and write performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS platforms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      billingMode TEXT NOT NULL,
      price INTEGER NOT NULL,
      totalCost INTEGER NOT NULL,
      status TEXT,
      archived INTEGER DEFAULT 0,
      archivedAt TEXT,
      archivedMonth TEXT
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      priorBalance INTEGER NOT NULL,
      customFee INTEGER,
      status TEXT,
      archivedAt TEXT,
      archivedMonth TEXT
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      memberId TEXT,
      platformId TEXT,
      memberName TEXT NOT NULL,
      platformName TEXT NOT NULL,
      startMonth TEXT NOT NULL,
      exitMonth TEXT,
      seatLabel TEXT,
      allowDuplicate INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      memberId TEXT NOT NULL,
      memberName TEXT NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      method TEXT NOT NULL,
      cycle TEXT NOT NULL,
      note TEXT,
      createdAt TEXT,
      recordedAt TEXT,
      status TEXT,
      voidedAt TEXT,
      voidedBy TEXT,
      voidReason TEXT
    );

    CREATE TABLE IF NOT EXISTS temp_charges (
      id TEXT PRIMARY KEY,
      memberId TEXT NOT NULL,
      memberName TEXT NOT NULL,
      date TEXT,
      amount INTEGER NOT NULL,
      desc TEXT,
      description TEXT,
      cycle TEXT,
      createdAt TEXT,
      recordedAt TEXT,
      status TEXT,
      voidedAt TEXT,
      voidedBy TEXT,
      voidReason TEXT
    );

    CREATE TABLE IF NOT EXISTS history (
      month TEXT PRIMARY KEY,
      balances_json TEXT NOT NULL,
      payments_json TEXT NOT NULL,
      temp_charges_json TEXT NOT NULL,
      seal_json TEXT
    );

    CREATE TABLE IF NOT EXISTS ledger_events (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      month TEXT NOT NULL,
      entityType TEXT,
      entityId TEXT,
      amount REAL,
      payload_json TEXT,
      hash TEXT,
      previousHash TEXT
    );
  `);

  db.close();
}

/**
 * Loads the database state from SQLite relational tables.
 */
export function loadFromSQLite(sqlitePath: string): Database {
  const db = new SqliteDatabase(sqlitePath);

  // Load metadata
  const metadataRows = db.prepare('SELECT key, value FROM metadata').all() as Array<{ key: string; value: string }>;
  const metadataMap = new Map(metadataRows.map(r => [r.key, r.value]));

  const currentMonth = metadataMap.get('currentMonth') || '2026/05';
  const baseMonth = metadataMap.get('baseMonth') || '2026/05';
  const bankInfo = metadataMap.get('bankInfo') || '';
  const reminderStyle = metadataMap.get('reminderStyle') || 'friendly';

  // Load platforms
  const platformRows = db.prepare('SELECT * FROM platforms').all() as any[];
  const platforms: Platform[] = platformRows.map(row => ({
    id: row.id,
    name: row.name,
    billingMode: row.billingMode as 'fixed' | 'split',
    price: Number(row.price),
    totalCost: Number(row.totalCost),
    status: row.status || undefined,
    archived: Boolean(row.archived),
    archivedAt: row.archivedAt || undefined,
    archivedMonth: row.archivedMonth || undefined
  }));

  // Load members
  const memberRows = db.prepare('SELECT * FROM members').all() as any[];
  const members: Member[] = memberRows.map(row => ({
    id: row.id,
    name: row.name,
    priorBalance: Number(row.priorBalance),
    customFee: row.customFee !== null ? Number(row.customFee) : null,
    status: row.status || undefined,
    archivedAt: row.archivedAt || undefined,
    archivedMonth: row.archivedMonth || undefined
  }));

  // Load subscriptions
  const subRows = db.prepare('SELECT * FROM subscriptions').all() as any[];
  const subscriptions: Subscription[] = subRows.map(row => ({
    id: row.id,
    memberId: row.memberId || '',
    platformId: row.platformId || '',
    memberName: row.memberName,
    platformName: row.platformName,
    startMonth: row.startMonth,
    exitMonth: row.exitMonth || undefined,
    seatLabel: row.seatLabel || undefined,
    allowDuplicate: Boolean(row.allowDuplicate)
  }));

  // Load payments
  const paymentRows = db.prepare('SELECT * FROM payments').all() as any[];
  const payments: Payment[] = paymentRows.map(row => ({
    id: row.id,
    memberId: row.memberId,
    memberName: row.memberName,
    date: row.date,
    amount: Number(row.amount),
    method: row.method,
    cycle: row.cycle,
    note: row.note || undefined,
    createdAt: row.createdAt || undefined,
    recordedAt: row.recordedAt || undefined,
    status: row.status || undefined,
    voidedAt: row.voidedAt || undefined,
    voidedBy: row.voidedBy || undefined,
    voidReason: row.voidReason || undefined
  }));

  // Load temp charges
  const chargeRows = db.prepare('SELECT * FROM temp_charges').all() as any[];
  const tempCharges: TempCharge[] = chargeRows.map(row => ({
    id: row.id,
    memberId: row.memberId,
    memberName: row.memberName,
    date: row.date || undefined,
    amount: Number(row.amount),
    desc: row.desc || undefined,
    description: row.description || undefined,
    cycle: row.cycle || undefined,
    createdAt: row.createdAt || undefined,
    recordedAt: row.recordedAt || undefined,
    status: row.status || undefined,
    voidedAt: row.voidedAt || undefined,
    voidedBy: row.voidedBy || undefined,
    voidReason: row.voidReason || undefined
  }));

  // Load history
  const historyRows = db.prepare('SELECT * FROM history').all() as any[];
  const history: HistoryEntry[] = historyRows.map(row => ({
    month: row.month,
    balances: JSON.parse(row.balances_json),
    payments: JSON.parse(row.payments_json),
    tempCharges: JSON.parse(row.temp_charges_json),
    seal: row.seal_json ? JSON.parse(row.seal_json) : undefined
  }));

  // Load ledger events
  const ledgerRows = db.prepare('SELECT * FROM ledger_events ORDER BY at ASC').all() as any[];
  const entries: LedgerEvent[] = ledgerRows.map(row => ({
    id: row.id,
    at: row.at,
    actor: row.actor,
    type: row.type,
    summary: row.summary,
    month: row.month || row.at.slice(0, 7).replace('-', '/'),
    entityType: row.entityType || '',
    entityId: row.entityId || null,
    amount: row.amount !== null ? Number(row.amount) : null,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    hash: row.hash || '',
    previousHash: row.previousHash || null
  }));

  db.close();

  const lastHash = metadataMap.get('ledgerLastHash') || (entries.length > 0 ? entries[entries.length - 1].hash : '');
  const updatedAt = metadataMap.get('ledgerUpdatedAt') || (entries.length > 0 ? entries[entries.length - 1].at : '');
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
    }
  };

  return normalizeDatabaseRelations(rawDb);
}

/**
 * Saves the database state to SQLite relational tables using a clean write transaction.
 */
export function saveToSQLite(sqlitePath: string, data: Database): void {
  const db = new SqliteDatabase(sqlitePath);

  // Wrap all insertions in a transaction for atomicity and high speed
  const runTransaction = db.transaction((dbState: Database) => {
    // 1. Metadata
    db.prepare('DELETE FROM metadata').run();
    const insertMetadata = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
    insertMetadata.run('currentMonth', dbState.currentMonth || '');
    insertMetadata.run('baseMonth', dbState.baseMonth || '');
    insertMetadata.run('bankInfo', dbState.bankInfo || '');
    insertMetadata.run('reminderStyle', dbState.reminderStyle || '');
    insertMetadata.run('ledgerLastHash', dbState.ledger?.lastHash || '');
    insertMetadata.run('ledgerUpdatedAt', dbState.ledger?.updatedAt || '');
    insertMetadata.run('ledgerVersion', String(dbState.ledger?.version || 1));

    // 2. Platforms
    db.prepare('DELETE FROM platforms').run();
    const insertPlatform = db.prepare(`
      INSERT INTO platforms (id, name, billingMode, price, totalCost, status, archived, archivedAt, archivedMonth)
      VALUES (@id, @name, @billingMode, @price, @totalCost, @status, @archived, @archivedAt, @archivedMonth)
    `);
    (dbState.platforms || []).forEach(p => {
      insertPlatform.run({
        id: p.id,
        name: p.name,
        billingMode: p.billingMode,
        price: p.price,
        totalCost: p.totalCost,
        status: p.status || null,
        archived: p.archived ? 1 : 0,
        archivedAt: p.archivedAt || null,
        archivedMonth: p.archivedMonth || null
      });
    });

    // 3. Members
    db.prepare('DELETE FROM members').run();
    const insertMember = db.prepare(`
      INSERT INTO members (id, name, priorBalance, customFee, status, archivedAt, archivedMonth)
      VALUES (@id, @name, @priorBalance, @customFee, @status, @archivedAt, @archivedMonth)
    `);
    (dbState.members || []).forEach(m => {
      insertMember.run({
        id: m.id,
        name: m.name,
        priorBalance: m.priorBalance,
        customFee: m.customFee,
        status: m.status || null,
        archivedAt: m.archivedAt || null,
        archivedMonth: m.archivedMonth || null
      });
    });

    // 4. Subscriptions
    db.prepare('DELETE FROM subscriptions').run();
    const insertSub = db.prepare(`
      INSERT INTO subscriptions (id, memberId, platformId, memberName, platformName, startMonth, exitMonth, seatLabel, allowDuplicate)
      VALUES (@id, @memberId, @platformId, @memberName, @platformName, @startMonth, @exitMonth, @seatLabel, @allowDuplicate)
    `);
    (dbState.subscriptions || []).forEach(s => {
      insertSub.run({
        id: s.id,
        memberId: s.memberId || null,
        platformId: s.platformId || null,
        memberName: s.memberName,
        platformName: s.platformName,
        startMonth: s.startMonth,
        exitMonth: s.exitMonth || null,
        seatLabel: s.seatLabel || null,
        allowDuplicate: s.allowDuplicate ? 1 : 0
      });
    });

    // 5. Payments
    db.prepare('DELETE FROM payments').run();
    const insertPayment = db.prepare(`
      INSERT INTO payments (id, memberId, memberName, date, amount, method, cycle, note, createdAt, recordedAt, status, voidedAt, voidedBy, voidReason)
      VALUES (@id, @memberId, @memberName, @date, @amount, @method, @cycle, @note, @createdAt, @recordedAt, @status, @voidedAt, @voidedBy, @voidReason)
    `);
    (dbState.payments || []).forEach(p => {
      insertPayment.run({
        id: p.id,
        memberId: p.memberId,
        memberName: p.memberName,
        date: p.date,
        amount: p.amount,
        method: p.method,
        cycle: p.cycle,
        note: p.note || null,
        createdAt: p.createdAt || null,
        recordedAt: p.recordedAt || null,
        status: p.status || null,
        voidedAt: p.voidedAt || null,
        voidedBy: p.voidedBy || null,
        voidReason: p.voidReason || null
      });
    });

    // 6. Temp Charges
    db.prepare('DELETE FROM temp_charges').run();
    const insertCharge = db.prepare(`
      INSERT INTO temp_charges (id, memberId, memberName, date, amount, desc, description, cycle, createdAt, recordedAt, status, voidedAt, voidedBy, voidReason)
      VALUES (@id, @memberId, @memberName, @date, @amount, @desc, @description, @cycle, @createdAt, @recordedAt, @status, @voidedAt, @voidedBy, @voidReason)
    `);
    (dbState.tempCharges || []).forEach(c => {
      insertCharge.run({
        id: c.id,
        memberId: c.memberId,
        memberName: c.memberName,
        date: c.date || null,
        amount: c.amount,
        desc: c.desc || null,
        description: c.description || null,
        cycle: c.cycle || null,
        createdAt: c.createdAt || null,
        recordedAt: c.recordedAt || null,
        status: c.status || null,
        voidedAt: c.voidedAt || null,
        voidedBy: c.voidedBy || null,
        voidReason: c.voidReason || null
      });
    });

    // 7. History
    db.prepare('DELETE FROM history').run();
    const insertHistory = db.prepare(`
      INSERT INTO history (month, balances_json, payments_json, temp_charges_json, seal_json)
      VALUES (@month, @balances_json, @payments_json, @temp_charges_json, @seal_json)
    `);
    (dbState.history || []).forEach(h => {
      insertHistory.run({
        month: h.month,
        balances_json: JSON.stringify(h.balances || []),
        payments_json: JSON.stringify(h.payments || []),
        temp_charges_json: JSON.stringify(h.tempCharges || []),
        seal_json: h.seal ? JSON.stringify(h.seal) : null
      });
    });

    // 8. Ledger Events
    db.prepare('DELETE FROM ledger_events').run();
    const insertEvent = db.prepare(`
      INSERT INTO ledger_events (id, at, actor, type, summary, month, entityType, entityId, amount, payload_json, hash, previousHash)
      VALUES (@id, @at, @actor, @type, @summary, @month, @entityType, @entityId, @amount, @payload_json, @hash, @previousHash)
    `);
    ((dbState.ledger && dbState.ledger.entries) || []).forEach((e: LedgerEvent) => {
      insertEvent.run({
        id: e.id,
        at: e.at,
        actor: e.actor,
        type: e.type,
        summary: e.summary,
        month: e.month || '',
        entityType: e.entityType || null,
        entityId: e.entityId || null,
        amount: e.amount !== undefined && e.amount !== null ? e.amount : null,
        payload_json: e.payload ? JSON.stringify(e.payload) : null,
        hash: e.hash || null,
        previousHash: e.previousHash || null
      });
    });
  });

  runTransaction(data);
  db.close();
}

/**
 * Migrates data from JSON file into SQLite database if the SQLite database is empty.
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
