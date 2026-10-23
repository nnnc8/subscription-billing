import type { RequestHandler } from 'express';
import type { Runtime } from '../runtime.js';

const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    // React style attributes need inline styles; index.css imports Google Fonts.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
].join('; ');

export function createSecurityHeaders(runtime: Runtime): RequestHandler {
    return (_req, res, next) => {
        res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        if (runtime.config.cookieSecure) {
            res.setHeader('Strict-Transport-Security', 'max-age=15552000');
        }
        next();
    };
}
