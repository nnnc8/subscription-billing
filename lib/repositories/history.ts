import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { HistoryEntry } from '../../src/types/billing.js';

export interface HistoryRow {
  month: string;
  balances_json: string;
  payments_json: string;
  temp_charges_json: string;
  seal_json: string | null;
}

export class HistoryRepository {
  static findAll(db: SqliteDatabase): HistoryEntry[] {
    const rows = db.prepare('SELECT * FROM history').all() as HistoryRow[];
    return rows.map(row => ({
      month: row.month,
      balances: JSON.parse(row.balances_json),
      payments: JSON.parse(row.payments_json),
      tempCharges: JSON.parse(row.temp_charges_json),
      seal: row.seal_json ? JSON.parse(row.seal_json) : undefined
    }));
  }

  static saveAll(db: SqliteDatabase, history: HistoryEntry[]): void {
    const insertStmt = db.prepare(`
      INSERT INTO history (month, balances_json, payments_json, temp_charges_json, seal_json)
      VALUES (@month, @balances_json, @payments_json, @temp_charges_json, @seal_json)
      ON CONFLICT(month) DO UPDATE SET
        balances_json = excluded.balances_json,
        payments_json = excluded.payments_json,
        temp_charges_json = excluded.temp_charges_json,
        seal_json = excluded.seal_json
    `);

    for (const h of history) {
      insertStmt.run({
        month: h.month,
        balances_json: JSON.stringify(h.balances || []),
        payments_json: JSON.stringify(h.payments || []),
        temp_charges_json: JSON.stringify(h.tempCharges || []),
        seal_json: h.seal ? JSON.stringify(h.seal) : null
      });
    }

    const months = history.map(h => h.month);
    if (months.length > 0) {
      const placeholders = months.map(() => '?').join(',');
      db.prepare(`DELETE FROM history WHERE month NOT IN (${placeholders})`).run(months);
    } else {
      db.prepare('DELETE FROM history').run();
    }
  }
}
