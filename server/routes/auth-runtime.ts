import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import {
    OAUTH_STATE_COOKIE_NAME,
    createOAuthStateValue,
    createSessionCookieValue,
} from '../../lib/auth.js';
import {
    buildGoogleAuthUrl,
    exchangeGoogleCode,
    fetchGoogleUserinfo,
    getGoogleOAuthConfig,
    isAllowedGoogleUser,
} from '../../lib/google-oauth.js';
import {
    buildOAuthStateCookie,
    buildSessionCookie,
    clearOAuthStateCookie,
    clearSessionCookie,
    getGoogleRedirectUri,
    parseCookies,
    verifyRequestSession,
} from '../middleware/auth.js';
import { emptyPayloadSchema, parseInput } from '../middleware/validation.js';
import type { Runtime } from '../runtime.js';

const callbackQuerySchema = z.object({
    code: z.string().min(1),
    state: z.string().min(1)
});

export function createAuthRuntimeRouter(runtime: Runtime): Router {
    const router = Router();

    router.get('/api/health', (_req, res) => {
        const readiness = runtime.getReadiness();
        const healthy = readiness.status === 'ready';
        res.status(healthy ? 200 : 503).json({
            ok: healthy,
            authConfigured: runtime.isAuthConfigured(),
            dataWritable: fs.existsSync(runtime.paths.dataDir)
                && fs.statSync(runtime.paths.dataDir).isDirectory(),
            host: runtime.config.host,
            port: runtime.config.port,
            readiness: readiness.status,
            ...(readiness.reason ? { readinessReason: readiness.reason } : {})
        });
    });

    router.get('/api/auth/session', (req, res) => {
        if (!runtime.isAuthConfigured()) {
            res.json({ authenticated: false, authConfigured: false });
            return;
        }
        const session = verifyRequestSession(runtime, req);
        res.json({
            authenticated: session.ok,
            ...(session.ok && session.session?.user ? { user: session.session.user } : {})
        });
    });

    router.get('/api/auth/login', (req, res) => {
        if (!runtime.isAuthConfigured()) {
            res.status(503).json({ error: 'Authentication is not configured' });
            return;
        }
        const config = getGoogleOAuthConfig(runtime.env);
        const state = createOAuthStateValue();
        const redirectUri = getGoogleRedirectUri(runtime, req);
        res.setHeader('Set-Cookie', buildOAuthStateCookie(runtime, state));
        res.redirect(buildGoogleAuthUrl({ config, redirectUri, state }));
    });

    router.get('/api/auth/callback', async (req, res) => {
        if (!runtime.isAuthConfigured()) {
            res.status(503).json({ error: 'Authentication is not configured' });
            return;
        }

        const parsed = callbackQuerySchema.safeParse(req.query);
        const stateCookie = parseCookies(req)[OAUTH_STATE_COOKIE_NAME];
        if (!parsed.success || !stateCookie || stateCookie !== parsed.data.state) {
            res.setHeader('Set-Cookie', clearOAuthStateCookie(runtime));
            res.status(400).json({ error: 'Invalid OAuth state' });
            return;
        }

        const config = getGoogleOAuthConfig(runtime.env);
        const redirectUri = getGoogleRedirectUri(runtime, req);
        try {
            const token = await exchangeGoogleCode({ config, code: parsed.data.code, redirectUri });
            const profile = await fetchGoogleUserinfo({ config, accessToken: String(token.access_token) });
            if (!isAllowedGoogleUser(profile, config.allowedEmails)) {
                res.setHeader('Set-Cookie', clearOAuthStateCookie(runtime));
                res.status(403).json({ error: 'Google account is not allowed' });
                return;
            }

            const email = String(profile.email).toLowerCase();
            const cookieValue = createSessionCookieValue({
                secret: runtime.env.APP_SESSION_SECRET || '',
                user: { email, name: String(profile.name || email) }
            });
            res.setHeader('Set-Cookie', [
                buildSessionCookie(runtime, cookieValue),
                clearOAuthStateCookie(runtime)
            ]);
            res.redirect('/');
        } catch (error) {
            res.setHeader('Set-Cookie', clearOAuthStateCookie(runtime));
            throw error;
        }
    });

    router.post('/api/auth/logout', (req, res) => {
        parseInput(emptyPayloadSchema, req.body ?? {}, 'Invalid logout payload');
        res.setHeader('Set-Cookie', clearSessionCookie(runtime));
        res.json({ authenticated: false });
    });

    return router;
}
