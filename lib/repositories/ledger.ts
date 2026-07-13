import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { LedgerEvent } from '../../src/types/billing.js';

export interface LedgerEventRow {
  id: string;
  at: string;
  actor: string;
  type: string;
  summary: string;
  month: string | null;
  entityType: string | null;
  entityId: string | null;
  amount: number | null;
  payload_json: string | null;
  hash: string | null;
  previousHash: string | null;
}

export class LedgerRepository {
  static findAll(db: SqliteDatabase): LedgerEvent[] {
    const rows = db.prepare('SELECT * FROM ledger_events ORDER BY at ASC').all() as LedgerEventRow[];
    return rows.map(row => ({
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
  }

  static saveAll(db: SqliteDatabase, entries: LedgerEvent[]): void {
    const insertStmt = db.prepare(`
      INSERT INTO ledger_events (id, at, actor, type, summary, month, entityType, entityId, amount, payload_json, hash, previousHash)
      VALUES (@id, @at, @actor, @type, @summary, @month, @entityType, @entityId, @amount, @payload_json, @hash, @previousHash)
      ON CONFLICT(id) DO UPDATE SET
        at = excluded.at,
        actor = excluded.actor,
        type = excluded.type,
        summary = excluded.summary,
        month = excluded.month,
        entityType = excluded.entityType,
        entityId = excluded.entityId,
        amount = excluded.amount,
        payload_json = excluded.payload_json,
        hash = excluded.hash,
        previousHash = excluded.previousHash
    `);

    for (const e of entries) {
      insertStmt.run({
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
    }

    const ids = entries.map(e => e.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM ledger_events WHERE id NOT IN (${placeholders})`).run(ids);
    } else {
      db.prepare('DELETE FROM ledger_events').run();
    }
  }
}
