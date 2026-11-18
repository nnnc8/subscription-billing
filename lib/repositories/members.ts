import type { InStatement } from '@libsql/client';
import { rowChanges, type SqlRow } from './shared.js';
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
  static readonly select = 'SELECT * FROM members';

  static decode(rows: MemberRow[]): Member[] {
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

  static encode(members: Member[]): SqlRow[] {
    return members.map(m => ({
        id: m.id,
        name: m.name,
        priorBalance: m.priorBalance,
        customFee: m.customFee,
        status: m.status || null,
        archivedAt: m.archivedAt || null,
        archivedMonth: m.archivedMonth || null
      }));
  }

  static changes(previous: Member[], next: Member[]): InStatement[] {
    return rowChanges('members', 'id', this.encode(previous), this.encode(next));
  }
}
