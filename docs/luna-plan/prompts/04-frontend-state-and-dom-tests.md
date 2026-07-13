# 04 — Frontend state、401 與 DOM tests

## Mission

Preserve state across four navigation surfaces and make auth/dialog/focus/toast behavior testable in DOM, while keeping product-native information architecture.

## Preconditions

- The runner must prepend or read docs/luna-plan/02-luna-runbook.md; direct invocation without it is invalid.

- 03 is verified_complete.
- Existing four navigation IDs remain dashboard, subscriptions, config and history.
- Do not add Members or Backup as top-level tabs.

## Exact write set

- src/App.tsx
- src/components/DashboardTab.tsx
- src/components/AutomationTab.tsx
- src/components/SettingsTab.tsx
- src/components/SubscriptionsTab.tsx
- src/types/billing.ts
- package.json
- pnpm-lock.yaml
- vitest.config.ts
- tests/frontend-dom.test.ts
- tests/frontend-tabs.test.ts
- docs/luna-plan/01-master-plan.md (status/evidence only)

Allowed new dev dependencies only here: @testing-library/react@16.3.2, @testing-library/dom@10.4.1, @testing-library/user-event@14.6.1, jsdom@29.1.1. Do not add a data-fetch cache library.

## Required implementation

1. AI/Automation first mount after entering Dashboard and stay mounted; hidden navigation does not unmount them. active controls effects/network only.
2. AutomationTab props are exactly active, apiFetch and onDataChange.
3. All account APIs use App apiFetch. Raw fetch remains only for session/login/logout.
4. DOM tests prove Dashboard filter, Subscriptions draft, Settings draft, History month and Automation input/filter survive navigation.
5. Prove 401 marks unauthenticated, dialog cancel/close works, opener focus returns, focus enters dialog, toast has status semantics and error messages are visible.
6. Keep existing native dialog and four navigation language. Do not replace with demo-only snapshots.

## Checks

~~~bash
pnpm test --run tests/frontend-dom.test.ts tests/frontend-tabs.test.ts
pnpm exec tsc --noEmit -p tsconfig.app.json
pnpm run build
~~~

真鍵盤 Esc is a Batch 08 browser smoke requirement; DOM tests may prove the event handler but must not claim browser proof.

## Failure, retry and rollback

Attempt limit: initial run, retry 1 and retry 2 only; each retry requires a new falsifiable hypothesis. After retry 2, restore product/prompt preimages, keep the master ledger status/evidence append-only, verify hashes and stop.

If lazy loading prevents state preservation, keep the chunk boundary but mount a stable shell on first entry. If test setup hides an actual focus bug, add a real DOM assertion. Do not remove state or weaken the requirement to “page re-fetches correctly.”

## Evidence and next

Record DOM values after each navigation, mount count, API calls gated by active, 401 state and focus targets. Next is 05 only after no account API bypasses apiFetch and all state assertions pass.
