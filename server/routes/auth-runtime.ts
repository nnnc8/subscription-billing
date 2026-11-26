import { Router } from 'express';
import type { Request, Response } from 'express';
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
import { renderSignInProblemPage, type SignInProblemPage } from '../sign-in-page.js';

const callbackQuerySchema = z.object({
    code: z.string().min(1),
    state: z.string().min(1)
});

// Google sends the person back to the callback as a page navigation. A JSON body there is a
// dead end, so a browser gets a page with a link that starts sign-in again. Scripts and other
// API clients keep the JSON body, and the status code is the same for both.
function sendSignInProblem(req: Request, res: Response, status: number, error: string, page: SignInProblemPage): void {
    res.status(status);
    res.vary('Accept');
    if (req.accepts(['json', 'html']) !== 'html') {
        res.json({ error });
        return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(renderSignInProblemPage(page));
}

export function createAuthRuntimeRouter(runtime: Runtime): Router {
    const router = Router();

    router.get('/api/health', async (req, res) => {
        try { await runtime.ensureReady(); } catch { /* Readiness details remain private. */ }
        const readiness = runtime.getReadiness();
        const healthy = readiness.status === 'ready';
        const summary = {
            ok: healthy,
            authConfigured: runtime.isAuthConfigured(),
            readiness: readiness.status
        };
        // The endpoint is public for health checks; failure reasons can name records, so
        // operational details are only shown to a signed-in operator.
        if (!runtime.isAuthConfigured() || !(await verifyRequestSession(runtime, req)).ok) {
            res.status(healthy ? 200 : 503).json(summary);
            return;
        }
        res.status(healthy ? 200 : 503).json({
            ...summary,
            dataWritable: healthy,
            host: runtime.config.host,
            port: runtime.config.port,
            ...(readiness.reason ? { readinessReason: readiness.reason } : {})
        });
    });

    router.get('/api/auth/session', async (req, res) => {
        if (!runtime.isAuthConfigured()) {
            res.json({ authenticated: false, authConfigured: false });
            return;
        }
        const session = await verifyRequestSession(runtime, req);
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
            sendSignInProblem(req, res, 400, 'Invalid OAuth state', {
                heading: '登入沒有完成',
                detail: '這次登入已經逾時，或是在中途取消了。請重新登入。',
                action: '重新登入'
            });
            return;
        }

        const config = getGoogleOAuthConfig(runtime.env);
        const redirectUri = getGoogleRedirectUri(runtime, req);
        try {
            const token = await exchangeGoogleCode({ config, code: parsed.data.code, redirectUri });
            const profile = await fetchGoogleUserinfo({ config, accessToken: String(token.access_token) });
            if (!isAllowedGoogleUser(profile, config.allowedEmails)) {
                res.setHeader('Set-Cookie', clearOAuthStateCookie(runtime));
                // The address is shown only to the person who just signed in to Google with it,
                // so they can tell that the browser used a different account than they expected.
                sendSignInProblem(req, res, 403, 'Google account is not allowed', {
                    heading: '這個 Google 帳號不能登入',
                    detail: '這個帳號沒有使用權限。請改用已獲准的 Google 帳號登入。',
                    action: '改用其他帳號登入',
                    ...(typeof profile.email === 'string' ? { account: profile.email } : {})
                });
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

    router.post('/api/auth/logout-all', async (req, res) => {
        parseInput(emptyPayloadSchema, req.body ?? {}, 'Invalid logout payload');
        if (!runtime.isAuthConfigured()) {
            res.status(503).json({ error: 'Authentication is not configured' });
            return;
        }
        if (!(await verifyRequestSession(runtime, req)).ok) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }
        await runtime.revokeAllSessions();
        res.setHeader('Set-Cookie', clearSessionCookie(runtime));
        res.json({ authenticated: false, revokedAllSessions: true });
    });

    return router;
}
