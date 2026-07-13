import type { Database as SqliteDatabase } from 'better-sqlite3';

export interface MetadataRow {
  key: string;
  value: string;
}

export class SettingsRepository {
  static load(db: SqliteDatabase): Map<string, string> {
    const rows = db.prepare('SELECT key, value FROM metadata').all() as MetadataRow[];
    return new Map(rows.map(r => [r.key, r.value]));
  }

  static save(db: SqliteDatabase, metadata: Record<string, string>): void {
    const upsertStmt = db.prepare(`
      INSERT INTO metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    for (const [key, value] of Object.entries(metadata)) {
      upsertStmt.run(key, value);
    }
  }
}
