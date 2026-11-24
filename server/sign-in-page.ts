const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => HTML_ESCAPES[character] ?? character);
}

export interface SignInProblemPage {
    heading: string;
    detail: string;
    /** Label of the link that starts a new sign-in. */
    action: string;
    /** The Google address that just signed in. Only the person who used it receives this page. */
    account?: string;
}

// The page has no script and no external resource, so it works under the site's
// Content-Security-Policy (inline styles are allowed there).
const PAGE_STYLE = [
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f5f1;color:#1f2933;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif;line-height:1.6}',
    'main{max-width:26rem;margin:1.5rem;padding:2rem;background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}',
    'h1{margin:0 0 .75rem;font-size:1.25rem}',
    'p{margin:.5rem 0}',
    '.account{font-weight:600;word-break:break-all}',
    '.primary{display:inline-block;margin-top:1.25rem;padding:.65rem 1.1rem;border-radius:10px;background:#1f2933;color:#fff;text-decoration:none}',
    '.secondary{display:inline-block;margin:1.25rem 0 0 .75rem;color:#52606d}'
].join('');

export function renderSignInProblemPage({ heading, detail, action, account }: SignInProblemPage): string {
    const accountLine = account
        ? `<p>你剛才使用的 Google 帳號：<span class="account">${escapeHtml(account)}</span></p>`
        : '';
    return [
        '<!doctype html>',
        '<html lang="zh-Hant">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="robots" content="noindex">',
        '<title>無法登入｜收支帳務</title>',
        `<style>${PAGE_STYLE}</style>`,
        '</head>',
        '<body>',
        '<main>',
        `<h1>${escapeHtml(heading)}</h1>`,
        accountLine,
        `<p>${escapeHtml(detail)}</p>`,
        `<a class="primary" href="/api/auth/login">${escapeHtml(action)}</a>`,
        '<a class="secondary" href="/">回到首頁</a>',
        '</main>',
        '</body>',
        '</html>'
    ].filter(Boolean).join('\n');
}
