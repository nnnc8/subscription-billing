import { describe, expect, it } from 'vitest';
import { escapeHtml, renderSignInProblemPage } from '../server/sign-in-page.js';

describe('sign-in problem page', () => {
    it('escapes every character that could change the markup', () => {
        expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
        expect(escapeHtml('owner@example.com')).toBe('owner@example.com');
    });

    it('shows the refused account as text and links to a new sign-in', () => {
        const html = renderSignInProblemPage({
            heading: '這個 Google 帳號不能登入',
            detail: '請改用已獲准的 Google 帳號登入。',
            action: '改用其他帳號登入',
            account: '"><script>alert(1)</script>@example.com'
        });

        expect(html.startsWith('<!doctype html>')).toBe(true);
        expect(html).toContain('<html lang="zh-Hant">');
        expect(html).toContain('<h1>這個 Google 帳號不能登入</h1>');
        expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;@example.com');
        expect(html).not.toContain('<script');
        expect(html).toContain('<a class="primary" href="/api/auth/login">改用其他帳號登入</a>');
        expect(html).toContain('<a class="secondary" href="/">回到首頁</a>');
    });

    it('leaves out the account line when there is no account to show', () => {
        const html = renderSignInProblemPage({
            heading: '登入沒有完成',
            detail: '請重新登入。',
            action: '重新登入'
        });

        expect(html).not.toContain('你剛才使用的 Google 帳號');
        expect(html).toContain('<a class="primary" href="/api/auth/login">重新登入</a>');
        expect(html).not.toContain('\n\n');
    });
});
