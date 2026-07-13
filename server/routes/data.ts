import { Router } from 'express';
import { monthToCode } from '../../lib/accounting.js';
import { getSystemMonth, runLifecycleCatchUp } from '../../lib/lifecycle.js';
import type { Database } from '../../src/types/billing.js';
import { MutationPersistenceError, type Runtime } from '../runtime.js';
import { readDatabase, withAudit } from './shared.js';

export function createDataRouter(runtime: Runtime): Router {
    const router = Router();

    router.get('/api/export-json', (_req, res) => {
        const db = readDatabase(runtime);
        res.setHeader('Content-Disposition', 'attachment; filename="subscription-billing-export.json"');
        res.type('application/json').send(JSON.stringify(db, null, 2));
    });

    router.get('/api/data', async (_req, res) => {
        let db: Database;
        try {
            const current = readDatabase(runtime);
            const systemMonth = getSystemMonth();
            const currentCode = monthToCode(current.currentMonth);
            const systemCode = monthToCode(systemMonth);
            if (
                runtime.env.NODE_ENV === 'test'
                || (currentCode !== null && systemCode !== null && currentCode >= systemCode)
            ) {
                db = current;
            } else {
                const result = await runtime.mutateDB(candidate => {
                    const results = runLifecycleCatchUp(candidate);
                    const blocked = results.find(item => item.blocked);
                    if (blocked) throw new Error(`Lifecycle blocked: ${blocked.blockedReason || 'integrity check failed'}`);
                    return results;
                }, { reason: 'lifecycle.data-read' });
                db = result.data;
            }
        } catch (error) {
            console.error('[lifecycle] /api/data catch-up error:', error);
            const persistedDb = runtime.readDB();
            if (!persistedDb) {
                res.status(503).json({ error: 'Service unavailable' });
                return;
            }
            if (error instanceof MutationPersistenceError) {
                db = persistedDb;
            } else if (error instanceof Error && error.message.startsWith('Lifecycle blocked:')) {
                res.status(503).json({ error: error.message });
                return;
            } else {
                db = persistedDb;
            }
        }
        res.json(withAudit(db));
    });

    return router;
}
