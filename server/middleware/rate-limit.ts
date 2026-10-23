import type { Request, RequestHandler } from 'express';
import type { Runtime } from '../runtime.js';

type Bucket = { count: number; resetAt: number };

export type RateLimitOptions = {
    windowMs: number;
    max: number;
    key: (req: Request) => string;
    message: string;
    now?: () => number;
};

const MAX_TRACKED_KEYS = 10_000;

/**
 * Fixed-window, in-memory limiter. That is enough here because the app only supports a
 * single instance (SQLite plus an in-process mutation queue); counters reset on restart.
 */
export function createRateLimiter({ windowMs, max, key, message, now = Date.now }: RateLimitOptions): RequestHandler {
    const buckets = new Map<string, Bucket>();
    return (req, res, next) => {
        const current = now();
        if (buckets.size > MAX_TRACKED_KEYS) {
            for (const [bucketKey, bucket] of buckets) {
                if (bucket.resetAt <= current) buckets.delete(bucketKey);
            }
        }

        const bucketKey = key(req);
        let bucket = buckets.get(bucketKey);
        if (!bucket || bucket.resetAt <= current) {
            bucket = { count: 0, resetAt: current + windowMs };
            buckets.set(bucketKey, bucket);
        }
        bucket.count += 1;
        if (bucket.count > max) {
            res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - current) / 1000)));
            res.status(429).json({ error: message });
            return;
        }
        next();
    };
}

/**
 * Client address for rate limiting. CLIENT_IP_HEADER names a header that the hosting proxy
 * always overwrites (Fly.io: fly-client-ip); without it the socket address is used.
 */
export function clientAddress(runtime: Runtime, req: Request): string {
    const headerName = String(runtime.env.CLIENT_IP_HEADER || '').trim().toLowerCase();
    const headerValue = headerName ? req.headers[headerName] : undefined;
    if (typeof headerValue === 'string' && headerValue.trim()) return headerValue.trim();
    return req.ip || req.socket.remoteAddress || 'unknown';
}

export function createAuthRateLimit(runtime: Runtime): RequestHandler {
    return createRateLimiter({
        windowMs: 15 * 60 * 1000,
        max: 30,
        key: req => `auth:${clientAddress(runtime, req)}`,
        message: '登入嘗試次數過多，請稍後再試'
    });
}

/** AI calls spend the operator's Gemini quota, so limit them per signed-in account. */
export function createAiRateLimits(runtime: Runtime): RequestHandler[] {
    const accountKey = (req: Request) => `ai:${req.session?.user?.email || clientAddress(runtime, req)}`;
    return [
        createRateLimiter({
            windowMs: 10 * 60 * 1000,
            max: 30,
            key: accountKey,
            message: 'AI 功能使用太頻繁，請稍後再試'
        }),
        createRateLimiter({
            windowMs: 24 * 60 * 60 * 1000,
            max: 300,
            key: accountKey,
            message: '今天的 AI 使用次數已達上限'
        })
    ];
}
