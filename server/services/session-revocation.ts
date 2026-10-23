import type { Client } from '@libsql/client';

/** Outside the billing snapshot; restoring a backup cannot revive revoked cookies. */
export function createSessionRevocationStore(client: Client) {
    async function sessionsRevokedBefore(): Promise<number> {
        const row = (await client.execute("SELECT value FROM auth_state WHERE key='sessionsRevokedBefore'")).rows[0];
        const cutoff = row ? Number(row.value) : 0;
        if (!Number.isFinite(cutoff)) throw new Error('Invalid session revocation state');
        return cutoff;
    }
    async function revokeAllSessions(now = Date.now()): Promise<number> {
        await client.execute({
            sql: "INSERT INTO auth_state (key,value) VALUES ('sessionsRevokedBefore',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)",
            args: [String(now)]
        });
        return sessionsRevokedBefore();
    }
    return { sessionsRevokedBefore, revokeAllSessions };
}
