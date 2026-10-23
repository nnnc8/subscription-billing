import path from 'node:path';
import express from 'express';
import { createRequireAuth } from './middleware/auth.js';
import { createCorsMiddleware } from './middleware/cors.js';
import { errorHandler } from './middleware/error.js';
import { createAiRateLimits, createAuthRateLimit } from './middleware/rate-limit.js';
import { createSecurityHeaders } from './middleware/security.js';
import { createAiAutomationRouter } from './routes/ai-automation.js';
import { createAuthRuntimeRouter } from './routes/auth-runtime.js';
import { createBackupRouter } from './routes/backup.js';
import { createBillingRouter } from './routes/billing.js';
import { createDataRouter } from './routes/data.js';
import { createLifecycleAuditRouter } from './routes/lifecycle-audit.js';
import { createSettingsEntitiesRouter } from './routes/settings-entities.js';
import { createRuntime, createTrustProxy, type Runtime } from './runtime.js';

export function createApp({
    runtime = createRuntime(),
    overrides = {}
}: {
    runtime?: Runtime;
    overrides?: Partial<Runtime>;
} = {}) {
    const activeRuntime = { ...runtime, ...overrides } as Runtime;
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', createTrustProxy(activeRuntime.env.TRUST_PROXY_CIDRS));
    app.use(createSecurityHeaders(activeRuntime));
    app.use(createCorsMiddleware(activeRuntime));
    app.use(express.json());
    app.use(express.static(activeRuntime.paths.distDir));

    app.use(['/api/auth/login', '/api/auth/callback', '/api/auth/logout-all'], createAuthRateLimit(activeRuntime));
    app.use(createAuthRuntimeRouter(activeRuntime));
    app.use('/api', createRequireAuth(activeRuntime));
    app.use(['/api/ai', '/api/automation/ingest'], ...createAiRateLimits(activeRuntime));
    app.use(createDataRouter(activeRuntime));
    app.use(createBillingRouter(activeRuntime));
    app.use(createSettingsEntitiesRouter(activeRuntime));
    app.use(createLifecycleAuditRouter(activeRuntime));
    app.use(createBackupRouter(activeRuntime));
    app.use(createAiAutomationRouter(activeRuntime));

    app.use(/\/api\/.*/, (_req, res) => {
        res.status(404).json({ error: 'Not found' });
    });
    app.use(errorHandler);
    app.get(/.*/, (_req, res) => {
        res.sendFile(path.join(activeRuntime.paths.distDir, 'index.html'));
    });
    return app;
}
