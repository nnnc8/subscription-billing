import type { InStatement } from '@libsql/client';
import { rowChanges, type SqlRow } from './shared.js';
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
  static readonly select = 'SELECT * FROM platforms';

  static decode(rows: PlatformRow[]): Platform[] {
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

  static encode(platforms: Platform[]): SqlRow[] {
    return platforms.map(p => ({
        id: p.id,
        name: p.name,
        billingMode: p.billingMode,
        price: p.price,
        totalCost: p.totalCost,
        status: p.status || null,
        archived: p.archived ? 1 : 0,
        archivedAt: p.archivedAt || null,
        archivedMonth: p.archivedMonth || null
      }));
  }

  static changes(previous: Platform[], next: Platform[]): InStatement[] {
    return rowChanges('platforms', 'id', this.encode(previous), this.encode(next));
  }
}
