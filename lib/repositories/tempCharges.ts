import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { TempCharge } from '../../src/types/billing.js';

export interface TempChargeRow {
  id: string;
  memberId: string;
  memberName: string;
  date: string | null;
  amount: number;
  desc: string | null;
  description: string | null;
  cycle: string | null;
  createdAt: string | null;
  recordedAt: string | null;
  status: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}

export class TempChargeRepository {
  static findAll(db: SqliteDatabase): TempCharge[] {
    const rows = db.prepare('SELECT * FROM temp_charges').all() as TempChargeRow[];
    return rows.map(row => ({
      id: row.id,
      memberId: row.memberId,
      memberName: row.memberName,
      amount: Number(row.amount),
      ...(row.date ? { date: row.date } : {}),
      ...(row.desc ? { desc: row.desc } : {}),
      ...(row.description ? { description: row.description } : {}),
      ...(row.cycle ? { cycle: row.cycle } : {}),
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
      ...(row.recordedAt ? { recordedAt: row.recordedAt } : {}),
      ...(row.status ? { status: row.status } : {}),
      ...(row.voidedAt ? { voidedAt: row.voidedAt } : {}),
      ...(row.voidedBy ? { voidedBy: row.voidedBy } : {}),
      ...(row.voidReason ? { voidReason: row.voidReason } : {})
    }));
  }

  static saveAll(db: SqliteDatabase, tempCharges: TempCharge[]): void {
    const insertStmt = db.prepare(`
      INSERT INTO temp_charges (id, memberId, memberName, date, amount, desc, description, cycle, createdAt, recordedAt, status, voidedAt, voidedBy, voidReason)
      VALUES (@id, @memberId, @memberName, @date, @amount, @desc, @description, @cycle, @createdAt, @recordedAt, @status, @voidedAt, @voidedBy, @voidReason)
      ON CONFLICT(id) DO UPDATE SET
        memberId = excluded.memberId,
        memberName = excluded.memberName,
        date = excluded.date,
        amount = excluded.amount,
        desc = excluded.desc,
        description = excluded.description,
        cycle = excluded.cycle,
        createdAt = excluded.createdAt,
        recordedAt = excluded.recordedAt,
        status = excluded.status,
        voidedAt = excluded.voidedAt,
        voidedBy = excluded.voidedBy,
        voidReason = excluded.voidReason
    `);

    for (const c of tempCharges) {
      insertStmt.run({
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
    }

    const ids = tempCharges.map(c => c.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM temp_charges WHERE id NOT IN (${placeholders})`).run(ids);
    } else {
      db.prepare('DELETE FROM temp_charges').run();
    }
  }
}
