import { Router } from 'express';
import { z } from 'zod';
import { appendLedgerEvent, getSystemSnapshot } from '../../lib/accounting.js';
import { emptyPayloadSchema, parseInput } from '../middleware/validation.js';
import type { Runtime } from '../runtime.js';
import { readDatabase, sendDatabase } from './shared.js';

const backupFilenameSchema = z.string().regex(/^database_\d{8}_\d{6}(?:(?:_\d{3})?_[a-f0-9]{8})?\.db$/);
const filenameParamsSchema = z.object({ filename: backupFilenameSchema });
const restoreSchema = z.object({ filename: backupFilenameSchema });

export function createBackupRouter(runtime: Runtime): Router {
    const router = Router();
    router.get('/api/backups', async (_req, res) => {
        res.json({ success: true, ...await runtime.listBackupInventory(await readDatabase(runtime)) });
    });
    router.get('/api/backups/:filename/preview', async (req, res) => {
        const { filename } = parseInput(filenameParamsSchema, req.params, '備份檔名格式不合法');
        const db = await readDatabase(runtime);
        res.json({ success: true, backup: await runtime.analyzeBackupFile(filename, getSystemSnapshot(db) as unknown as Record<string, unknown>) });
    });
    router.post('/api/backups/restore', async (req, res) => {
        const { filename } = parseInput(restoreSchema, req.body, '請指定備份檔案名稱');
        const data = await runtime.enqueueExclusive(() => runtime.restoreSQLiteFromBackup(filename, {
            type: 'backup.restored', summary: `還原備份 ${filename}`, entityType: 'backup', entityId: filename, payload: { filename }
        }));
        runtime.invalidateRAGIndex();
        sendDatabase(res, data, { message: `已還原至 ${filename}` });
    });
    router.post('/api/backups/create', async (req, res) => {
        parseInput(emptyPayloadSchema, req.body ?? {}, 'Invalid backup payload');
        const filename = await runtime.enqueueExclusive(() => runtime.backupDB('manual', true));
        sendDatabase(res, await readDatabase(runtime), { filename, message: `備份已建立: ${filename}` });
    });
    router.delete('/api/backups/:filename', async (req, res) => {
        const { filename } = parseInput(filenameParamsSchema, req.params, '備份檔名格式不合法');
        parseInput(emptyPayloadSchema, req.body ?? {}, 'Invalid backup delete payload');
        const { data } = await runtime.mutateDB(db => {
            appendLedgerEvent(db, { type: 'backup.deleted', summary: `刪除備份 ${filename}`, entityType: 'backup', entityId: filename, payload: { filename } });
        }, { reason: 'backup.delete', backup: false, afterSave: tx => runtime.deleteBackup(tx, filename) });
        sendDatabase(res, data, { message: `備份已刪除: ${filename}`, cleanupPending: false });
    });
    return router;
}
