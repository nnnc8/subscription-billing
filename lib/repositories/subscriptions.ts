import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { Subscription } from '../../src/types/billing.js';

export interface SubscriptionRow {
  id: string;
  memberId: string | null;
  platformId: string | null;
  memberName: string;
  platformName: string;
  startMonth: string;
  exitMonth: string | null;
  seatLabel: string | null;
  allowDuplicate: number;
}

export class SubscriptionRepository {
  static findAll(db: SqliteDatabase): Subscription[] {
    const rows = db.prepare('SELECT * FROM subscriptions').all() as SubscriptionRow[];
    return rows.map(row => ({
      id: row.id,
      memberId: row.memberId || '',
      platformId: row.platformId || '',
      memberName: row.memberName,
      platformName: row.platformName,
      startMonth: row.startMonth,
      allowDuplicate: Boolean(row.allowDuplicate),
      ...(row.exitMonth ? { exitMonth: row.exitMonth } : {}),
      ...(row.seatLabel ? { seatLabel: row.seatLabel } : {})
    }));
  }

  static saveAll(db: SqliteDatabase, subscriptions: Subscription[]): void {
    const insertStmt = db.prepare(`
      INSERT INTO subscriptions (id, memberId, platformId, memberName, platformName, startMonth, exitMonth, seatLabel, allowDuplicate)
      VALUES (@id, @memberId, @platformId, @memberName, @platformName, @startMonth, @exitMonth, @seatLabel, @allowDuplicate)
      ON CONFLICT(id) DO UPDATE SET
        memberId = excluded.memberId,
        platformId = excluded.platformId,
        memberName = excluded.memberName,
        platformName = excluded.platformName,
        startMonth = excluded.startMonth,
        exitMonth = excluded.exitMonth,
        seatLabel = excluded.seatLabel,
        allowDuplicate = excluded.allowDuplicate
    `);

    for (const s of subscriptions) {
      insertStmt.run({
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
    }

    const ids = subscriptions.map(s => s.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM subscriptions WHERE id NOT IN (${placeholders})`).run(ids);
    } else {
      db.prepare('DELETE FROM subscriptions').run();
    }
  }
}
