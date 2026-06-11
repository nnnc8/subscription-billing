const DEFAULT_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GOOGLE_SCOPE = 'openid email profile';

function parseAllowedEmails(value) {
    return new Set(String(value || '')
        .split(',')
        .map(email => email.trim().toLowerCase())
        .filter(Boolean));
}

function getGoogleOAuthConfig(env = process.env) {
    return {
        clientId: env.GOOGLE_CLIENT_ID || '',
        clientSecret: env.GOOGLE_CLIENT_SECRET || '',
        allowedEmails: parseAllowedEmails(env.GOOGLE_ALLOWED_EMAILS),
        authUrl: env.GOOGLE_OAUTH_AUTH_URL || DEFAULT_AUTH_URL,
        tokenUrl: env.GOOGLE_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL,
        userinfoUrl: env.GOOGLE_OAUTH_USERINFO_URL || DEFAULT_USERINFO_URL,
        redirectUri: env.GOOGLE_REDIRECT_URI || ''
    };
}

function isGoogleOAuthConfigured(env = process.env) {
    const config = getGoogleOAuthConfig(env);
    return Boolean(config.clientId && config.clientSecret && config.allowedEmails.size > 0);
}

function buildGoogleAuthUrl({ config, redirectUri, state }) {
    const url = new URL(config.authUrl);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
}

function isAllowedGoogleUser(profile, allowedEmails) {
    const email = typeof profile?.email === 'string' ? profile.email.toLowerCase() : '';
    return Boolean(email && profile.email_verified === true && allowedEmails.has(email));
}

async function exchangeGoogleCode({ config, code, redirectUri, fetchImpl = fetch }) {
    const body = new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
    });

    const res = await fetchImpl(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.access_token) {
        const err = new Error('Google token exchange failed');
        err.status = 502;
        throw err;
    }
    return payload;
}

async function fetchGoogleUserinfo({ config, accessToken, fetchImpl = fetch }) {
    const res = await fetchImpl(config.userinfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.email) {
        const err = new Error('Google userinfo fetch failed');
        err.status = 502;
        throw err;
    }
    return payload;
}

module.exports = {
    GOOGLE_SCOPE,
    buildGoogleAuthUrl,
    exchangeGoogleCode,
    fetchGoogleUserinfo,
    getGoogleOAuthConfig,
    isAllowedGoogleUser,
    isGoogleOAuthConfigured,
    parseAllowedEmails
};
