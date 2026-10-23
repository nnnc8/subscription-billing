import type { InStatement } from '@libsql/client';
import { rowChanges, type SqlRow } from './shared.js';
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
  static readonly select = 'SELECT * FROM ledger_events ORDER BY at ASC';

  static decode(rows: LedgerEventRow[]): LedgerEvent[] {
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

  static encode(entries: LedgerEvent[]): SqlRow[] {
    return entries.map(e => ({
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
      }));
  }

  static changes(previous: LedgerEvent[], next: LedgerEvent[]): InStatement[] {
    return rowChanges('ledger_events', 'id', this.encode(previous), this.encode(next));
  }
}
