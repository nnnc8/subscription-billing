import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Member } from '../../src/types/billing.js';

export interface MemberRow {
  id: string;
  name: string;
  priorBalance: number;
  customFee: number | null;
  status: string | null;
  archivedAt: string | null;
  archivedMonth: string | null;
}

export class MemberRepository {
  static findAll(db: SqliteDatabase): Member[] {
    const rows = db.prepare('SELECT * FROM members').all() as MemberRow[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      priorBalance: Number(row.priorBalance),
      customFee: row.customFee !== null ? Number(row.customFee) : null,
      ...(row.status ? { status: row.status } : {}),
      ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
      ...(row.archivedMonth ? { archivedMonth: row.archivedMonth } : {})
    }));
  }

  static saveAll(db: SqliteDatabase, members: Member[]): void {
    const insertStmt = db.prepare(`
      INSERT INTO members (id, name, priorBalance, customFee, status, archivedAt, archivedMonth)
      VALUES (@id, @name, @priorBalance, @customFee, @status, @archivedAt, @archivedMonth)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        priorBalance = excluded.priorBalance,
        customFee = excluded.customFee,
        status = excluded.status,
        archivedAt = excluded.archivedAt,
        archivedMonth = excluded.archivedMonth
    `);

    for (const m of members) {
      insertStmt.run({
        id: m.id,
        name: m.name,
        priorBalance: m.priorBalance,
        customFee: m.customFee,
        status: m.status || null,
        archivedAt: m.archivedAt || null,
        archivedMonth: m.archivedMonth || null
      });
    }

    const ids = members.map(m => m.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM members WHERE id NOT IN (${placeholders})`).run(ids);
    } else {
      db.prepare('DELETE FROM members').run();
    }
  }
}
