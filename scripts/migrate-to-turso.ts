import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAccountingWarnings } from '../lib/accounting.js';
import { getCanonicalPersistedFingerprint, loadFromConnection, openDatabase, runMigrations, verifyDatabase, withWriteTransaction, writeDatabase } from '../lib/db.js';
import { createBackupService } from '../server/services/backup.js';

export type MigrationOptions = { sourcePath: string; targetUrl: string; authToken?: string; force?: boolean; dryRun?: boolean };
export async function migrateToTurso(options: MigrationOptions) {
    const sourcePath = path.resolve(options.sourcePath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error('Source database does not exist');
    if (!options.targetUrl) throw new Error('TURSO_DATABASE_URL is required');
    if (options.targetUrl.startsWith('file:')) {
        const targetPath = fileURLToPath(options.targetUrl);
        if ((fs.existsSync(targetPath) ? fs.realpathSync(targetPath) : path.resolve(targetPath)) === fs.realpathSync(sourcePath)) throw new Error('Source and target must be different databases');
    }
    const source = openDatabase(sourcePath);
    const data = await (async () => {
        try { return await loadFromConnection(source); }
        finally { source.close(); }
    })();
    if (findAccountingWarnings(data).some(warning => warning.severity === 'high' || warning.severity === 'critical')) throw new Error('Source database failed domain validation');
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
            await writeDatabase(tx, previous, data);
            await verifyDatabase(tx, data);
        });
        // Independently verify the committed state, not only the transaction's own snapshot.
        if (getCanonicalPersistedFingerprint(await loadFromConnection(target)) !== fingerprint) throw new Error('Committed target fingerprint mismatch');
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
