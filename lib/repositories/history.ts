import type { InStatement } from '@libsql/client';
import { rowChanges, type SqlRow } from './shared.js';
import type { HistoryEntry } from '../../src/types/billing.js';

export interface HistoryRow {
  month: string;
  balances_json: string;
  payments_json: string;
  temp_charges_json: string;
  seal_json: string | null;
}

export class HistoryRepository {
  static readonly select = 'SELECT * FROM history';

  static decode(rows: HistoryRow[]): HistoryEntry[] {
    return rows.map(row => ({
      month: row.month,
      balances: JSON.parse(row.balances_json),
      payments: JSON.parse(row.payments_json),
      tempCharges: JSON.parse(row.temp_charges_json),
      seal: row.seal_json ? JSON.parse(row.seal_json) : undefined
    }));
  }

  static encode(history: HistoryEntry[]): SqlRow[] {
    return history.map(h => ({
        month: h.month,
        balances_json: JSON.stringify(h.balances || []),
        payments_json: JSON.stringify(h.payments || []),
        temp_charges_json: JSON.stringify(h.tempCharges || []),
        seal_json: h.seal ? JSON.stringify(h.seal) : null
      }));
  }

  static changes(previous: HistoryEntry[], next: HistoryEntry[]): InStatement[] {
    return rowChanges('history', 'month', this.encode(previous), this.encode(next));
  }
}
