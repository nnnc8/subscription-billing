import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../src/components/DashboardTab.tsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../src/components/SettingsTab.tsx', import.meta.url), 'utf8');

describe('frontend tab lifecycle', () => {
  test('keeps all four tab components mounted behind native hidden panels', () => {
    expect(appSource).toContain("<section hidden={activeTab !== 'dashboard'}");
    expect(appSource).toContain("<section hidden={activeTab !== 'subscriptions'}");
    expect(appSource).toContain("<section hidden={activeTab !== 'config'}");
    expect(appSource).toContain("<section hidden={activeTab !== 'history'}");
    expect(appSource).not.toContain("{activeTab === 'dashboard' && <DashboardTab");
  });

  test('gates hidden-tab network and lazy AI work on the active flag', () => {
    expect(settingsSource).toContain('if (!active) return undefined;');
    expect(dashboardSource).toContain('workspaceMounted');
    expect(dashboardSource).toContain('<div hidden={!active} className="ai-workspace-grid">');
    expect(dashboardSource).toContain('<AutomationTab active={active} apiFetch={apiFetch} onDataChange={refreshData} />');
    expect(dashboardSource).toContain('<AiAssistantTab aiMessages={aiMessages}');
  });
});
