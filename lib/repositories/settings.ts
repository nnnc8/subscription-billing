import type { InStatement } from '@libsql/client';
import { rowChanges } from './shared.js';

export interface MetadataRow { key: string; value: string }
export class SettingsRepository {
  static decode(rows: MetadataRow[]): Map<string, string> {
    return new Map(rows.map(row => [row.key, row.value]));
  }
  static changes(previous: Record<string, string>, next: Record<string, string>): InStatement[] {
    const encode = (metadata: Record<string, string>) => Object.entries(metadata).map(([key, value]) => ({ key, value }));
    return rowChanges('metadata', 'key', encode(previous), encode(next));
  }
}
