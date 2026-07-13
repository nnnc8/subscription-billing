# 05 — Hardened TypeScript 與 lint zero

## Mission

Turn current non-hardened green checks into real strict gates without using any, ts-ignore, blanket rule disable, unjustified non-null assertion or blanket undefined widening.

## Preconditions

- The runner must prepend or read docs/luna-plan/02-luna-runbook.md; direct invocation without it is invalid.

- 04 is verified_complete.
- Read current tsconfig, eslint config and the exact error list.
- Preserve public route and frontend behavior.

## Exact write set

- tsconfig.app.json
- tsconfig.node.json
- tsconfig.test.json (new; explicit tests typecheck project)
- package.json
- pnpm-lock.yaml
- eslint.config.js
- lib/accounting.ts
- lib/ai-assistant.ts
- lib/auth.ts
- lib/automation.ts
- lib/google-oauth.ts
- lib/lifecycle.ts
- lib/repositories/members.ts
- lib/repositories/payments.ts
- lib/repositories/platforms.ts
- lib/repositories/subscriptions.ts
- lib/repositories/tempCharges.ts
- server/routes/ai-automation.ts
- src/components/DashboardTab.tsx
- tests/ai-transport.test.ts
- tests/automation.test.ts
- tests/accounting.test.ts
- tests/domain-validation.test.ts
- tests/lifecycle.test.ts
- tests/portability.test.ts
- tests/privacy.test.ts
- tests/rollover.test.ts
- docs/luna-plan/01-master-plan.md (status/evidence only)

Do not touch Docker, CI, plist, README, unrelated generated files or production data. First produce the hardened compiler inventory. If it names a source/test path outside the fixed list, stop and create a separate docs-only scope revision that names those exact paths in this prompt and the master ledger before editing; do not modify this prompt during the product attempt and do not use an open-ended affected-files glob.

## Required implementation

1. Enable noUncheckedIndexedAccess and exactOptionalPropertyTypes in app and node configs.
2. Set engine to >=22.12.0 and keep Vite/Node/Docker/CI aligned.
3. Fix every current hardened error and the five known lint warnings.
4. No any, @ts-ignore, rule shutdown, blanket non-null assertions or type widening without a local invariant.
5. Keep the current route inventory, active-month semantics, ledger and UI behavior.

## Checks

~~~bash
pnpm exec tsc --noEmit -p tsconfig.app.json
pnpm exec tsc --noEmit -p tsconfig.node.json
pnpm exec tsc --noEmit -p tsconfig.test.json
pnpm exec eslint . --max-warnings=0
pnpm test --run
pnpm run build
~~~

The gate is the same command set after a clean dependency install is possible; current tsc green before flags is not sufficient.

## Failure, retry and rollback

Attempt limit: initial run, retry 1 and retry 2 only; each retry requires a new falsifiable hypothesis. After retry 2, restore product/prompt preimages, keep the master ledger status/evidence append-only, verify hashes and stop.

If a type error reveals a real domain ambiguity, model that ambiguity explicitly near the boundary. Do not cast it away. If lint requires a rule exception, prove the exact local reason or stop; never disable the rule globally.

Initial + two retries only. After retry 2 restore product/prompt preimages, keep the master ledger status/evidence append-only, and record the remaining exact error.

## Evidence and next

Record compiler flags, zero error/warning counts, Node version and full test/build results. Next is 06 only when strict typecheck and lint --max-warnings=0 are green together.
