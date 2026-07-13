import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Payment } from '../../src/types/billing.js';

export interface PaymentRow {
  id: string;
  memberId: string;
  memberName: string;
  date: string;
  amount: number;
  method: string;
  cycle: string;
  note: string | null;
  createdAt: string | null;
  recordedAt: string | null;
  status: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}

export class PaymentRepository {
  static findAll(db: SqliteDatabase): Payment[] {
    const rows = db.prepare('SELECT * FROM payments').all() as PaymentRow[];
    return rows.map(row => ({
      id: row.id,
      memberId: row.memberId,
      memberName: row.memberName,
      date: row.date,
      amount: Number(row.amount),
      method: row.method,
      cycle: row.cycle,
      ...(row.note ? { note: row.note } : {}),
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
      ...(row.recordedAt ? { recordedAt: row.recordedAt } : {}),
      ...(row.status ? { status: row.status } : {}),
      ...(row.voidedAt ? { voidedAt: row.voidedAt } : {}),
      ...(row.voidedBy ? { voidedBy: row.voidedBy } : {}),
      ...(row.voidReason ? { voidReason: row.voidReason } : {})
    }));
  }

  static saveAll(db: SqliteDatabase, payments: Payment[]): void {
    const insertStmt = db.prepare(`
      INSERT INTO payments (id, memberId, memberName, date, amount, method, cycle, note, createdAt, recordedAt, status, voidedAt, voidedBy, voidReason)
      VALUES (@id, @memberId, @memberName, @date, @amount, @method, @cycle, @note, @createdAt, @recordedAt, @status, @voidedAt, @voidedBy, @voidReason)
      ON CONFLICT(id) DO UPDATE SET
        memberId = excluded.memberId,
        memberName = excluded.memberName,
        date = excluded.date,
        amount = excluded.amount,
        method = excluded.method,
        cycle = excluded.cycle,
        note = excluded.note,
        createdAt = excluded.createdAt,
        recordedAt = excluded.recordedAt,
        status = excluded.status,
        voidedAt = excluded.voidedAt,
        voidedBy = excluded.voidedBy,
        voidReason = excluded.voidReason
    `);

    for (const p of payments) {
      insertStmt.run({
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
    }

    const ids = payments.map(p => p.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM payments WHERE id NOT IN (${placeholders})`).run(ids);
    } else {
      db.prepare('DELETE FROM payments').run();
    }
  }
}
