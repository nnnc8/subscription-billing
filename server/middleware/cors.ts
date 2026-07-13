import type { RequestHandler } from 'express';
import type { Runtime } from '../runtime.js';

function normalizeOrigin(value: string): string | null {
    try {
        const url = new URL(value);
        if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
        return url.origin;
    } catch {
        return null;
    }
}

export function isAllowedOrigin(runtime: Runtime, origin: string): boolean {
    if (!origin) return true;
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;

    const configured = new Set([
        runtime.env.PUBLIC_ORIGIN || '',
        ...String(runtime.env.ALLOWED_ORIGINS || '').split(',')
    ]
        .map(value => normalizeOrigin(value.trim()))
        .filter((value): value is string => Boolean(value)));

    return configured.has(normalized);
}

export function createCorsMiddleware(runtime: Runtime): RequestHandler {
    return (req, res, next) => {
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
        if (origin) {
            const normalizedOrigin = normalizeOrigin(origin);
            if (!normalizedOrigin || !isAllowedOrigin(runtime, origin)) {
                res.status(403).json({ error: 'CORS origin blocked' });
                return;
            }
            res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.setHeader('Access-Control-Allow-Headers', String(req.headers['access-control-request-headers'] || 'Content-Type'));
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
            res.setHeader('Vary', 'Origin');
        }

        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    };
}
