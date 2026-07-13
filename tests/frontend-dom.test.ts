/* @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/App.js';
import type { Database, HistoryEntry } from '../src/types/billing.js';

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'fixtures/demo-database.json'), 'utf8'),
) as Database;

const historyEntries: HistoryEntry[] = [
  {
    month: '2026/05',
    balances: fixture.members.map((member) => ({
      memberId: member.id,
      memberName: member.name,
      priorBalance: member.priorBalance,
      subscriptionFee: 100,
      tempCharge: 0,
      paid: 0,
      endingBalance: 100,
    })),
    payments: [],
    tempCharges: [],
  },
  {
    month: '2026/06',
    balances: fixture.members.map((member) => ({
      memberId: member.id,
      memberName: member.name,
      priorBalance: member.priorBalance,
      subscriptionFee: 100,
      tempCharge: 0,
      paid: 0,
      endingBalance: 100,
    })),
    payments: [],
    tempCharges: [],
  },
];

const appData: Database = { ...fixture, history: historyEntries };
const originalFetch = globalThis.fetch;
const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchMock(options: { unauthorizedData?: boolean } = {}): void {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/session') return jsonResponse({ authenticated: true, user: { email: 'test@example.com' } });
    if (url === '/api/data' && options.unauthorizedData) return jsonResponse({ error: 'Unauthorized' }, 401);
    if (url === '/api/data') return jsonResponse(appData);
    if (url === '/api/lifecycle/status') {
      return jsonResponse({
        success: true,
        currentMonth: appData.currentMonth,
        systemMonth: appData.currentMonth,
        isCurrent: true,
        timezone: 'Asia/Taipei',
        lastAdvancedAt: null,
        lastAdvancedFrom: null,
        lastAdvancedTo: null,
        blockedReason: null,
      });
    }
    if (url === '/api/automation/ingest') {
      return jsonResponse({
        applied: [],
        rejected: [],
        parseErrors: [],
        pending: [{
          id: 'proposal_frontend_1',
          kind: 'payment',
          sourceText: 'Member Alpha 轉 270',
          confidence: 0.91,
          reason: '測試待覆核',
          warnings: [],
          payload: { memberName: 'Member Alpha', amount: 270, date: '2026-06-15' },
          status: 'pending',
          rejectReason: null,
          ledgerEventId: null,
        }],
      });
    }
    if (url.startsWith('/api/')) return jsonResponse({ success: true, data: appData });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;
}

function dashboard(): HTMLElement {
  return screen.getByRole('region', { name: '總覽' });
}

function tabPanel(label: string): HTMLElement {
  const panel = document.querySelector(`section[aria-label="${label}"]`);
  if (!(panel instanceof HTMLElement)) throw new Error(`Missing tab panel: ${label}`);
  return panel;
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModalPolyfill() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function closePolyfill() {
    this.open = false;
  };
});

beforeEach(() => {
  localStorage.clear();
  installFetchMock();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

describe('frontend navigation and state persistence', () => {
  test('keeps dashboard, subscription, settings, history, and automation state across navigation', async () => {
    const user = userEvent.setup();
    render(createElement(App));
    await screen.findByRole('region', { name: '總覽' });

    const logSearch = screen.getByRole('textbox', { name: '搜尋流水帳' });
    await user.type(logSearch, 'demo');

    await user.click(screen.getByRole('button', { name: '訂閱名額' }));
    const subscriptions = screen.getByRole('region', { name: '訂閱名額' });
    await user.selectOptions(within(subscriptions).getByLabelText('選擇成員姓名'), 'Member Alpha');
    await user.type(within(subscriptions).getByLabelText('起算月份 (YYYY/MM)'), '2026/07');

    await user.click(screen.getByRole('button', { name: '設定' }));
    const settings = screen.getByRole('region', { name: '設定' });
    const bankInfo = within(settings).getByLabelText('匯款帳戶資訊');
    await user.clear(bankInfo);
    await user.type(bankInfo, 'draft-only-bank-info');

    await user.click(screen.getByRole('button', { name: '歷史紀錄' }));
    const history = screen.getByRole('region', { name: '歷史紀錄' });
    await user.selectOptions(within(history).getByLabelText('帳期'), '2026/05');

    await user.click(screen.getByRole('button', { name: '總覽' }));
    const automationText = await within(dashboard()).findByLabelText('帳務文字');
    await user.type(automationText, 'Member Alpha 轉 270');
    await user.click(within(dashboard()).getByRole('button', { name: '解析並入帳' }));
    await within(dashboard()).findByRole('button', { name: /待覆核/ });
    await user.click(within(dashboard()).getByRole('button', { name: /待覆核/ }));

    await user.click(screen.getByRole('button', { name: '訂閱名額' }));
    await user.click(screen.getByRole('button', { name: '設定' }));
    await user.click(screen.getByRole('button', { name: '歷史紀錄' }));
    await user.click(screen.getByRole('button', { name: '總覽' }));

    expect((screen.getByRole('textbox', { name: '搜尋流水帳' }) as HTMLInputElement).value).toBe('demo');
    const hiddenSubscriptions = tabPanel('訂閱名額');
    const hiddenSettings = tabPanel('設定');
    const hiddenHistory = tabPanel('歷史紀錄');
    expect((within(hiddenSubscriptions).getByLabelText('選擇成員姓名') as HTMLSelectElement).value).toBe('Member Alpha');
    expect((within(hiddenSubscriptions).getByLabelText('起算月份 (YYYY/MM)') as HTMLInputElement).value).toBe('2026/07');
    expect((within(hiddenSettings).getByLabelText('匯款帳戶資訊') as HTMLTextAreaElement).value).toBe('draft-only-bank-info');
    expect((within(hiddenHistory).getByLabelText('帳期') as HTMLSelectElement).value).toBe('2026/05');
    expect((within(dashboard()).getByLabelText('帳務文字') as HTMLTextAreaElement).value).toBe('Member Alpha 轉 270');
    expect(within(dashboard()).getByRole('button', { name: /待覆核/ }).getAttribute('aria-pressed')).toBe('true');
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/automation/ingest')).toHaveLength(1);
  });

  test('uses the shared apiFetch for automation requests', async () => {
    const user = userEvent.setup();
    render(createElement(App));
    await screen.findByRole('region', { name: '總覽' });
    const workspace = await within(dashboard()).findByLabelText('帳務文字');
    await user.type(workspace, 'Member Alpha 轉 270');
    await user.click(within(dashboard()).getByRole('button', { name: '解析並入帳' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/automation/ingest')).toBe(true));
    expect(fetchMock.mock.calls.find(([input]) => String(input) === '/api/automation/ingest')?.[1]).toMatchObject({ credentials: 'include' });
  });
});

describe('frontend auth and dialog accessibility', () => {
  test('turns a data 401 into the login screen', async () => {
    installFetchMock({ unauthorizedData: true });
    render(createElement(App));
    expect(await screen.findByRole('button', { name: '使用 Google 登入' })).toBeTruthy();
  });

  test('returns focus after dialog cancel/close and exposes toast status', async () => {
    const user = userEvent.setup();
    render(createElement(App));
    await screen.findByRole('region', { name: '總覽' });
    const dashboardPanel = dashboard();
    const paymentOpener = within(dashboardPanel).getAllByRole('button', { name: '記錄收款' })[0] as HTMLElement;
    expect(paymentOpener).toBeDefined();
    await user.click(paymentOpener);

    const dialog = await screen.findByRole('dialog', { name: /登記收款/ });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('付款金額 (NT$)')));
    fireEvent(dialog, new Event('cancel', { bubbles: true, cancelable: true }));
    await waitFor(() => expect(dialog.hasAttribute('open')).toBe(false));
    expect(document.activeElement).toBe(paymentOpener);

    await user.click(paymentOpener);
    const closeButton = await screen.findByRole('button', { name: '關閉登記收款' });
    await user.click(closeButton);
    await waitFor(() => expect(dialog.hasAttribute('open')).toBe(false));
    expect(document.activeElement).toBe(paymentOpener);

    await user.click(screen.getByRole('button', { name: '顯示系統歡迎訊息' }));
    expect(screen.getByRole('status').textContent).toContain('歡迎使用共乘訂閱對帳系統！');
  });
});
