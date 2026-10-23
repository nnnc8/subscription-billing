import { openDatabase, withWriteTransaction } from '../lib/db.js';

const marker = '__subscription_billing_test_database';
const signature = 'disposable-only-v1';
export function assertDisposableTestUrl(url: string): void {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
        throw new Error('Only a disposable loopback HTTP database without credentials is allowed');
    }
}
/** Refuse existing databases unless a previous test run created our marker. */
export async function resetTestDatabase(url: string): Promise<void> {
    assertDisposableTestUrl(url);
    const client = openDatabase(url);
    try {
        await withWriteTransaction(client, async tx => {
            const tables = (await tx.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows.map(row => String(row.name));
            if (tables.includes(marker)) {
                if ((await tx.execute(`SELECT value FROM ${marker} WHERE id=1`)).rows[0]?.value !== signature) throw new Error('Invalid disposable test database marker');
            } else if (tables.length) {
                throw new Error('Refusing to reset an existing database without the disposable test marker. Start turso dev with a new empty file.');
            } else {
                await tx.execute(`CREATE TABLE ${marker} (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`);
                await tx.execute({ sql: `INSERT INTO ${marker} VALUES (1,?)`, args: [signature] });
            }
            const removed = tables.filter(table => table !== marker);
            if (removed.length) await tx.batch(removed.map(table => `DROP TABLE "${table.replaceAll('"', '""')}"`));
        });
    } finally { client.close(); }
}
