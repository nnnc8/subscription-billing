import type { InStatement, InValue } from '@libsql/client';

export type SqlRow = Record<string, InValue>;
export const DELETE_CHUNK_SIZE = 500;

/** Compare encoded rows, so absent optional properties and SQL NULL compare equally. */
export function rowChanges(table: string, key: string, previous: SqlRow[], next: SqlRow[]): InStatement[] {
    const before = new Map(previous.map(row => [row[key], row]));
    const after = new Map(next.map(row => [row[key], row]));
    if (after.size !== next.length) throw new Error(`Duplicate primary key in ${table}`);
    const statements: InStatement[] = [];
    for (const row of next) {
        if (JSON.stringify(before.get(row[key])) === JSON.stringify(row)) continue;
        const columns = Object.keys(row);
        statements.push({
            sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(${key}) DO UPDATE SET ${columns.filter(column => column !== key).map(column => `${column}=excluded.${column}`).join(',')}`,
            args: columns.map(column => row[column]!)
        });
    }
    const removed = previous.filter(row => !after.has(row[key])).map(row => row[key]!);
    for (let start = 0; start < removed.length; start += DELETE_CHUNK_SIZE) {
        const ids = removed.slice(start, start + DELETE_CHUNK_SIZE);
        statements.push({ sql: `DELETE FROM ${table} WHERE ${key} IN (${ids.map(() => '?').join(',')})`, args: ids });
    }
    return statements;
}
