import type { InStatement } from '@libsql/client';
import { rowChanges, type SqlRow } from './shared.js';
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
  static readonly select = 'SELECT * FROM temp_charges';

  static decode(rows: TempChargeRow[]): TempCharge[] {
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

  static encode(tempCharges: TempCharge[]): SqlRow[] {
    return tempCharges.map(c => ({
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
      }));
  }

  static changes(previous: TempCharge[], next: TempCharge[]): InStatement[] {
    return rowChanges('temp_charges', 'id', this.encode(previous), this.encode(next));
  }
}
