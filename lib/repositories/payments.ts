import type { InStatement } from '@libsql/client';
import { rowChanges, type SqlRow } from './shared.js';
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
  static readonly select = 'SELECT * FROM payments';

  static decode(rows: PaymentRow[]): Payment[] {
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

  static encode(payments: Payment[]): SqlRow[] {
    return payments.map(p => ({
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
      }));
  }

  static changes(previous: Payment[], next: Payment[]): InStatement[] {
    return rowChanges('payments', 'id', this.encode(previous), this.encode(next));
  }
}
