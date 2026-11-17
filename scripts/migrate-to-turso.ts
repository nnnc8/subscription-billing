import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAccountingWarnings, normalizeDatabaseRelations } from '../lib/accounting.js';
import { getCanonicalPersistedFingerprint, loadFromConnection, openDatabase, readMetadataRows, replaceMetadataRows, runMigrations, verifyDatabase, withWriteTransaction, writeDatabase } from '../lib/db.js';
import { runLifecycleCatchUp } from '../lib/lifecycle.js';
import { createBackupService } from '../server/services/backup.js';
import { raiseSessionCutoff } from '../server/services/session-revocation.js';
import type { Database } from '../src/types/billing.js';

export type MigrationOptions = { sourcePath: string; targetUrl: string; authToken?: string; force?: boolean; dryRun?: boolean };

/**
 * The app closes every month up to the clock month on its first request and then checks the
 * result, failing every request while either step fails. Run the same steps on a copy, so a
 * source the app could not open is refused. The import still writes the source unchanged.
 */
function assertLifecycleCatchUp(data: Database): void {
    const caughtUp = structuredClone(data);
    const blocked = runLifecycleCatchUp(caughtUp).find(result => result.blocked);
    if (blocked) throw new Error(`Lifecycle catch-up is blocked at ${caughtUp.currentMonth}: ${blocked.blockedReason || 'integrity check failed'}`);
    normalizeDatabaseRelations(caughtUp);
    const warnings = findAccountingWarnings(caughtUp).filter(warning => warning.severity === 'high' || warning.severity === 'critical');
    if (warnings.length) throw new Error(`Domain validation fails in ${caughtUp.currentMonth} after the lifecycle catch-up: ${warnings.slice(0, 3).map(warning => `${warning.code}: ${warning.detail}`).join('; ')}`);
}
export async function migrateToTurso(options: MigrationOptions) {
    const sourcePath = path.resolve(options.sourcePath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error('Source database does not exist');
    if (!options.targetUrl) throw new Error('TURSO_DATABASE_URL is required');
    if (options.targetUrl.startsWith('file:')) {
        const targetPath = fileURLToPath(options.targetUrl);
        if ((fs.existsSync(targetPath) ? fs.realpathSync(targetPath) : path.resolve(targetPath)) === fs.realpathSync(sourcePath)) throw new Error('Source and target must be different databases');
    }
    const source = openDatabase(sourcePath);
    const { data, metadataRows } = await (async () => {
        try {
            // One read transaction, so the raw metadata rows come from the same snapshot as the data.
            const tx = await source.transaction('read');
            try { return { data: await loadFromConnection(tx), metadataRows: await readMetadataRows(tx) }; }
            finally { tx.close(); }
        }
        finally { source.close(); }
    })();
    if (findAccountingWarnings(data).some(warning => warning.severity === 'high' || warning.severity === 'critical')) throw new Error('Source database failed domain validation');
    assertLifecycleCatchUp(data);
    const fingerprint = getCanonicalPersistedFingerprint(data);
    const summary = {
        imported: false, dryRun: Boolean(options.dryRun),
        fingerprintSha256: crypto.createHash('sha256').update(fingerprint).digest('hex'),
        counts: { members: data.members.length, platforms: data.platforms.length, subscriptions: data.subscriptions.length, payments: data.payments.length, tempCharges: data.tempCharges.length, history: data.history.length, ledger: data.ledger.entries.length }
    };
    if (options.dryRun) return summary;
    const target = openDatabase(options.targetUrl, options.authToken);
    try {
        await runMigrations(target);
        await withWriteTransaction(target, async tx => {
            const previous = await loadFromConnection(tx);
            const occupied = Object.values({ members: previous.members, platforms: previous.platforms, subscriptions: previous.subscriptions, payments: previous.payments, tempCharges: previous.tempCharges, history: previous.history, ledger: previous.ledger.entries }).some(rows => rows.length > 0)
                || (await tx.execute('SELECT key FROM metadata LIMIT 1')).rows.length > 0;
            if (occupied && !options.force) throw new Error('Target contains business data; use --force only after reviewing a backup');
            if (occupied) await createBackupService({ client: target }).insertBackup(tx, previous, 'migration.safety');
            // Cookies issued before the import stop working; a later cutoff already in the target stays.
            await raiseSessionCutoff(tx, Date.now());
            await writeDatabase(tx, previous, data);
            // Every source metadata row, also those equal to a code default, which writeDatabase skips.
            await replaceMetadataRows(tx, metadataRows);
            await verifyDatabase(tx, data);
        });
        // Independently verify the committed state, not only the transaction's own snapshot.
        if (getCanonicalPersistedFingerprint(await loadFromConnection(target)) !== fingerprint) throw new Error('Committed target fingerprint mismatch');
        // The fingerprint reads metadata through defaults, so also compare the stored rows.
        if (JSON.stringify(await readMetadataRows(target)) !== JSON.stringify(metadataRows)) throw new Error('Committed target metadata mismatch');
        return { ...summary, imported: true };
    } finally { target.close(); }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log('Usage: pnpm migrate:turso --source /path/to/database.db [--dry-run] [--force]\nSet TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the environment. Tokens are never printed.');
        return;
    }
    const sourceIndex = args.indexOf('--source');
    const sourcePath = args[sourceIndex + 1];
    const allowed = args.filter((_arg, index) => index !== sourceIndex && index !== sourceIndex + 1);
    if (sourceIndex < 0 || !sourcePath || sourcePath.startsWith('--') || allowed.some(arg => !['--force', '--dry-run'].includes(arg))) throw new Error('Usage: pnpm migrate:turso --source /path/to/database.db [--dry-run] [--force]');
    const result = await migrateToTurso({ sourcePath, targetUrl: process.env.TURSO_DATABASE_URL || '', ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {}), force: args.includes('--force'), dryRun: args.includes('--dry-run') });
    console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => {
        // Driver errors may contain connection details; CLI output deliberately omits them.
        console.error('Migration failed. Check source schema, target connection, and existing target data. No credentials were printed.');
        process.exitCode = 1;
    });
}
