import fs from 'node:fs';
import path from 'node:path';

type SessionRevocationState = {
    sessionsRevokedBefore: number;
};

/**
 * Persists the "sign out every device" cutoff next to, but outside, the billing database.
 * Keeping it out of SQLite means restoring an old backup can never revive revoked sessions.
 */
export function createSessionRevocationStore(statePath: string) {
    let cachedCutoff: number | null = null;

    function sessionsRevokedBefore(): number {
        if (cachedCutoff !== null) return cachedCutoff;
        try {
            const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<SessionRevocationState>;
            if (!Number.isFinite(parsed.sessionsRevokedBefore)) {
                throw new Error(`Invalid session revocation state: ${statePath}`);
            }
            cachedCutoff = Number(parsed.sessionsRevokedBefore);
        } catch (error) {
            // A missing file means nothing was ever revoked; anything else fails closed.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            cachedCutoff = 0;
        }
        return cachedCutoff;
    }

    function revokeAllSessions(now = Date.now()): number {
        const state: SessionRevocationState = { sessionsRevokedBefore: now };
        const temporaryPath = `${statePath}.${process.pid}.tmp`;
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(temporaryPath, JSON.stringify(state), 'utf8');
        fs.renameSync(temporaryPath, statePath);
        cachedCutoff = now;
        return now;
    }

    return { sessionsRevokedBefore, revokeAllSessions };
}
