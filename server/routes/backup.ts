import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { appendLedgerEvent, getSystemSnapshot } from '../../lib/accounting.js';
import { httpError } from '../middleware/error.js';
import { emptyPayloadSchema, parseInput } from '../middleware/validation.js';
import type { Runtime } from '../runtime.js';
import { mutateAndSend, readDatabase, sendDatabase } from './shared.js';

const backupFilenameSchema = z.string()
    .regex(/^database_\d{8}_\d{6}(?:(?:_\d{3})?_[a-f0-9]{8})?\.db$/);
const filenameParamsSchema = z.object({ filename: backupFilenameSchema });
const restoreSchema = z.object({ filename: backupFilenameSchema });

export function createBackupRouter(runtime: Runtime): Router {
    const router = Router();

    router.get('/api/backups', (_req, res) => {
        res.json({ success: true, ...runtime.listBackupInventory(readDatabase(runtime)) });
    });

    router.get('/api/backups/:filename/preview', (req, res) => {
        const { filename } = parseInput(filenameParamsSchema, req.params, '備份檔名格式不合法');
        const db = readDatabase(runtime);
        const backup = runtime.analyzeBackupFile(
            filename,
            getSystemSnapshot(db) as unknown as Record<string, unknown>
        );
        res.json({ success: true, backup });
    });

    router.post('/api/backups/restore', async (req, res) => {
        const { filename } = parseInput(restoreSchema, req.body, '請指定備份檔案名稱');
        const restoredDb = await runtime.enqueueExclusive(async () => {
            const backupPath = runtime.safeBackupPath(filename);
            if (!fs.existsSync(backupPath)) throw httpError(404, '備份檔案不存在');
            runtime.validateBackupDatabase(backupPath);
            return runtime.restoreSQLiteFromBackup(backupPath, {
                type: 'backup.restored',
                summary: `還原備份 ${filename}`,
                entityType: 'backup',
                entityId: filename,
                payload: { filename }
            });
        });
        sendDatabase(res, restoredDb, { message: `已還原至 ${filename}` });
    });

    router.post('/api/backups/create', async (req, res) => {
        parseInput(emptyPayloadSchema, req.body ?? {}, 'Invalid backup payload');
        const backupPath = await runtime.backupDB();
        if (!backupPath) {
            res.status(500).json({ error: '備份建立失敗' });
            return;
        }
        const filename = path.basename(backupPath);
        await mutateAndSend(runtime, res, () => ({
            extra: { filename, message: `備份已建立: ${filename}` },
            event: {
                type: 'backup.created',
                summary: `建立手動備份 ${filename}`,
                entityType: 'backup',
                entityId: filename,
                payload: { filename }
            }
        }), { reason: 'backup.create', backup: false });
    });

    router.delete('/api/backups/:filename', async (req, res) => {
        const { filename } = parseInput(filenameParamsSchema, req.params, '備份檔名格式不合法');
        parseInput(emptyPayloadSchema, req.body ?? {}, 'Invalid backup delete payload');
        const tombstonePath = runtime.moveBackupToTombstone(filename);
        try {
            const { data } = await runtime.mutateDB(db => {
                appendLedgerEvent(db, {
                    type: 'backup.deleted',
                    summary: `刪除備份 ${filename}`,
                    entityType: 'backup',
                    entityId: filename,
                    payload: { filename, tombstone: path.basename(tombstonePath) }
                });
            }, { reason: 'backup.delete' });

            try {
                runtime.removeBackupTombstone(tombstonePath);
                sendDatabase(res, data, { message: `備份已刪除: ${filename}`, cleanupPending: false });
            } catch (cleanupError) {
                console.error('Backup delete cleanup pending:', cleanupError);
                sendDatabase(res, data, {
                    message: `備份刪除已記錄，等待清理: ${filename}`,
                    cleanupPending: true
                });
            }
        } catch (error) {
            try {
                runtime.restoreBackupTombstone(tombstonePath, filename);
            } catch (restoreError) {
                console.error('Backup delete ledger failed and tombstone restore failed:', error, restoreError);
            }
            throw error;
        }
    });

    return router;
}
