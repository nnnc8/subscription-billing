import fs from 'node:fs';
import type { Client, Transaction } from '@libsql/client';

/** Raises the stored cutoff and never lowers it, whichever writer commits last. */
export async function raiseSessionCutoff(connection: Client | Transaction, cutoff: number): Promise<void> {
    await connection.execute({
        sql: "INSERT INTO auth_state (key,value) VALUES ('sessionsRevokedBefore',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)",
        args: [String(cutoff)]
    });
}

/**
 * Versions before this store kept the cutoff in DATA_DIR/auth-state.json as
 * {"sessionsRevokedBefore": <ms>}. Raising the stored cutoff to it keeps an earlier
 * "sign out every device" across the upgrade. A missing file means nothing was revoked.
 * An unusable file is reported and skipped, because it must never stop the app from starting.
 */
export async function importLegacySessionCutoff(client: Client, statePath: string): Promise<void> {
    let cutoff: unknown;
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (parsed && typeof parsed === 'object') cutoff = (parsed as { sessionsRevokedBefore?: unknown }).sessionsRevokedBefore;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    }
    if (typeof cutoff !== 'number' || !Number.isSafeInteger(cutoff) || cutoff < 0) {
        console.warn(`Ignored ${statePath}: it has no valid sessionsRevokedBefore, so an earlier "sign out every device" cutoff was not imported.`);
        return;
    }
    await raiseSessionCutoff(client, cutoff);
}

/** Outside the billing snapshot; restoring a backup cannot revive revoked cookies. */
export function createSessionRevocationStore(client: Client) {
    async function sessionsRevokedBefore(): Promise<number> {
        const row = (await client.execute("SELECT value FROM auth_state WHERE key='sessionsRevokedBefore'")).rows[0];
        const cutoff = row ? Number(row.value) : 0;
        if (!Number.isFinite(cutoff)) throw new Error('Invalid session revocation state');
        return cutoff;
    }
    async function revokeAllSessions(now = Date.now()): Promise<number> {
        await raiseSessionCutoff(client, now);
        return sessionsRevokedBefore();
    }
    return { sessionsRevokedBefore, revokeAllSessions };
}
