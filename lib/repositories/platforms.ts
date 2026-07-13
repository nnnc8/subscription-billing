import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Platform } from '../../src/types/billing.js';

export interface PlatformRow {
  id: string;
  name: string;
  billingMode: string;
  price: number;
  totalCost: number;
  status: string | null;
  archived: number;
  archivedAt: string | null;
  archivedMonth: string | null;
}

export class PlatformRepository {
  static findAll(db: SqliteDatabase): Platform[] {
    const rows = db.prepare('SELECT * FROM platforms').all() as PlatformRow[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      billingMode: row.billingMode as 'fixed' | 'split',
      price: Number(row.price),
      totalCost: Number(row.totalCost),
      archived: Boolean(row.archived),
      ...(row.status ? { status: row.status } : {}),
      ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
      ...(row.archivedMonth ? { archivedMonth: row.archivedMonth } : {})
    }));
  }

  static saveAll(db: SqliteDatabase, platforms: Platform[]): void {
    const insertStmt = db.prepare(`
      INSERT INTO platforms (id, name, billingMode, price, totalCost, status, archived, archivedAt, archivedMonth)
      VALUES (@id, @name, @billingMode, @price, @totalCost, @status, @archived, @archivedAt, @archivedMonth)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        billingMode = excluded.billingMode,
        price = excluded.price,
        totalCost = excluded.totalCost,
        status = excluded.status,
        archived = excluded.archived,
        archivedAt = excluded.archivedAt,
        archivedMonth = excluded.archivedMonth
    `);

    for (const p of platforms) {
      insertStmt.run({
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
    }

    const ids = platforms.map(p => p.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM platforms WHERE id NOT IN (${placeholders})`).run(ids);
    } else {
      db.prepare('DELETE FROM platforms').run();
    }
  }
}
