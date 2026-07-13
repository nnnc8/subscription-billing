# 06 — Coverage、verify、bundle 與 CI

## Mission

Make one reproducible quality entry point and measure coverage/bundle from the final 04–05 suite without gaming thresholds or excluding difficult UI.

## Preconditions

- The runner must prepend or read docs/luna-plan/02-luna-runbook.md; direct invocation without it is invalid.

- 05 is verified_complete.
- Existing tests and production build are green under strict/lint gates.
- Do not invent a diff base from the dirty worktree.

## Exact write set

- package.json
- pnpm-lock.yaml
- vitest.config.ts
- vite.config.ts
- scripts/bundle-gate.cjs
- tests/coverage-gate.test.ts (new; only if a deterministic behavior test is needed)
- .github/workflows/verify.yml
- docs/luna-plan/01-master-plan.md (status/evidence only)

Allowed dependency only here: @vitest/coverage-v8@4.1.9, aligned with installed Vitest. Do not add diff-coverage.

## Required implementation

1. Add coverage v8 and explicit include for server.ts, server/**/*.ts, lib/**/*.ts and src/**/*.{ts,tsx}. Do not use removed coverage.all or exclude hard UI.
2. Run the final suite once and set statements/branches/functions/lines to floor(measured percent × 100) / 100. Do not lower a threshold to pass or add an exclude.
3. Make pnpm verify run lint → app typecheck → node typecheck → full coverage test → legacy checks → build → bundle gate.
4. CI Node 22/24 invokes pnpm verify as the common gate, and pnpm verify explicitly runs the test typecheck project.
5. Vite produces a manifest. Bundle gate recursively sums gzip bytes of every static-import JS from main entry; excludes CSS and dynamic imports; confirms AI/Automation are dynamic entries.
6. Budget is min(189030, ceil(measuredBytes / 1024) × 1024).
7. Docker job has needs: verify; it cannot be only docker build.

References for implementation:

- https://v4.vitest.dev/guide/migration
- https://vite.dev/guide/backend-integration.html

## Checks

~~~bash
pnpm verify
pnpm exec tsc --noEmit -p tsconfig.test.json
pnpm exec vitest run --coverage
pnpm exec vite build
pnpm run bundle:gate
git diff --check
~~~

Inspect coverage include/exclude and manifest rather than trusting an exit code alone.

## Failure, retry and rollback

Attempt limit: initial run, retry 1 and retry 2 only; each retry requires a new falsifiable hypothesis. After retry 2, restore product/prompt preimages, keep the master ledger status/evidence append-only, verify hashes and stop.

If coverage is lower than expected, stop and name an exact behavior-test path in this write set and the master ledger before editing it, or record the uncovered invariant; do not change the floor downward. If bundle accounting follows a dynamic import, treat that as a manifest/gate bug, not a reason to count every chunk as initial.

## Evidence and next

Record measured coverage, threshold math, manifest path, exact gzip bytes, dynamic entry proof, verify output and CI configuration. Next is 07 only after one local verify path is green and CI invokes it.
