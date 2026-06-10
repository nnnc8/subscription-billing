const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    appendLedgerEvent,
    ensureHistorySeals,
    getHistoryIntegrity,
    normalizeDatabaseRelations
} = require('./lib/accounting.cjs');

const DB_PATH = path.join(__dirname, 'database.json');
const BACKUP_DIR = path.join(__dirname, 'backups');

function backupDatabase() {
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }
    const now = new Date();
    const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0')
    ].join('') + '_' + [
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0')
    ].join('') + `_${String(now.getMilliseconds()).padStart(3, '0')}`;
    const filename = `database_${stamp}_${crypto.randomUUID().slice(0, 8)}.json`;
    const backupPath = path.join(BACKUP_DIR, filename);
    fs.copyFileSync(DB_PATH, backupPath);
    return filename;
}

const rawDb = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const alreadySealed = (rawDb.history || []).every(entry => entry.seal && entry.seal.hash);
const db = normalizeDatabaseRelations(rawDb);

if (!alreadySealed) {
    const backupFilename = backupDatabase();
    (rawDb.history || []).forEach((entry, index) => {
        if ((!entry.seal || !entry.seal.hash) && db.history[index]) {
            delete db.history[index].seal;
        }
    });
    ensureHistorySeals(db, { sealedAt: new Date().toISOString(), reason: 'history-seal-v1' });
    const integrity = getHistoryIntegrity(db);
    appendLedgerEvent(db, {
        type: 'history.sealed',
        summary: `封存 ${integrity.sealedCount} 期歷史帳`,
        entityType: 'history',
        entityId: integrity.latestMonth,
        payload: {
            backupFilename,
            sealedCount: integrity.sealedCount,
            latestMonth: integrity.latestMonth,
            latestHash: integrity.latestHash
        }
    });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    console.log(`History seals migrated. Backup: ${backupFilename}`);
} else {
    console.log('History seals already present.');
}
