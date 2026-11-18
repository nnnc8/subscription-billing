import fs from 'node:fs';
import type { Request, Response, NextFunction } from 'express';
import { expect, it } from 'vitest';
import { createSecurityHeaders } from '../server/middleware/security.js';
import type { Runtime } from '../server/runtime.js';

it('keeps Vercel static headers identical to secure API responses', () => {
    const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
    const expected = Object.fromEntries(config.headers[0].headers.map((header: { key: string; value: string }) => [header.key, header.value]));
    const actual: Record<string, string> = {};
    createSecurityHeaders({ config: { cookieSecure: true } } as Runtime)(
        {} as Request,
        { setHeader: (key: string, value: string) => { actual[key] = value; } } as unknown as Response,
        (() => undefined) as NextFunction
    );
    expect(actual).toEqual(expected);
    expect(config.framework).toBe('vite');
    expect(config.outputDirectory).toBe('dist');
    expect(config.regions).toEqual(['hnd1']);
    expect(config.functions['api/index.ts'].includeFiles).toBe('lib/migrations/*.sql');
    expect(config.rewrites[0]).toEqual({ source: '/api/(.*)', destination: '/api' });
});
