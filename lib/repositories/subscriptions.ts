import type { InStatement } from '@libsql/client';
import { rowChanges, type SqlRow } from './shared.js';
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
  static readonly select = 'SELECT * FROM subscriptions';

  static decode(rows: SubscriptionRow[]): Subscription[] {
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

  static encode(subscriptions: Subscription[]): SqlRow[] {
    return subscriptions.map(s => ({
        id: s.id,
        memberId: s.memberId || null,
        platformId: s.platformId || null,
        memberName: s.memberName,
        platformName: s.platformName,
        startMonth: s.startMonth,
        exitMonth: s.exitMonth || null,
        seatLabel: s.seatLabel || null,
        allowDuplicate: s.allowDuplicate ? 1 : 0
      }));
  }

  static changes(previous: Subscription[], next: Subscription[]): InStatement[] {
    return rowChanges('subscriptions', 'id', this.encode(previous), this.encode(next));
  }
}
