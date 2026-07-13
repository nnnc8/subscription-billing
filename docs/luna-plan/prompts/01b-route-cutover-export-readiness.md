# 01B — 一般 mutation、export 與 readiness

## Mission

把一般帳務 mutation、lifecycle persistence、automation apply/confirm 與 export/readiness 接到 01A durable protocol，不縮小原目標，不改 38 route method/path。

## Preconditions

- The runner must prepend or read docs/luna-plan/02-luna-runbook.md; direct invocation without it is invalid.

- 01A is verified_complete with concurrency and rollback evidence.
- Re-read current route graph and exact callers of writeDB.
- Use temp DATA_DIR, dynamic port and dummy auth.

## Exact write set

- server/runtime.ts
- server/app.ts
- server/routes/data.ts
- server/routes/settings-entities.ts
- server/routes/lifecycle-audit.ts
- server/routes/ai-automation.ts
- server/routes/shared.ts
- server/routes/auth-runtime.ts
- tests/server.integration.test.ts
- tests/mutation-queue.test.ts
- docs/luna-plan/01-master-plan.md (status/evidence only)

Do not modify lib/ai.ts, frontend, package/lock, Docker, CI, plist or production data.

## Required implementation

1. Move settings, subscriptions, settle, lifecycle apply, automation confirm and all ordinary writes into fresh-state queue.
2. Keep Gemini/network await outside the queue. On apply, re-read latest state and revalidate proposal, member, identity, duplicate and active calendar period.
3. Reject stale proposal/base fingerprints fail closed; never merge silently.
4. Keep /api/export-json as authenticated GET, but return JSON attachment with Content-Disposition. It must not write runtime.paths.dbPath or database.json.
5. DB read/migration/required lifecycle persistence failure prevents server listen. A later runtime failure makes /api/health return 503.
6. Domain integrity blocks startup and reports blocked state; it never silently writes an old month.
7. Remove writeDB calls from normal routes. Keep only an explicitly named recovery adapter until Batch 02 is proven.

## Checks

~~~bash
pnpm test --run tests/server.integration.test.ts tests/mutation-queue.test.ts
pnpm run verify
~~~

Add assertions for:

- Content-Disposition attachment and JSON round-trip;
- dbPath absent or mtime unchanged after export;
- unauthenticated export is rejected;
- route method/path inventory remains 38;
- lifecycle write failure does not expose an unpersisted month;
- readiness failure prevents listen and health becomes 503.

## Failure, retry and rollback

Attempt limit: initial run, retry 1 and retry 2 only; each retry requires a new falsifiable hypothesis. After retry 2, restore product/prompt preimages, keep the master ledger status/evidence append-only, verify hashes and stop.

Do not solve a stale write by widening the merge. If a route response changes unexpectedly, restore the old response shape and retain the queue underneath. If readiness behavior conflicts with a test harness, add an explicit test runtime seam; do not silently skip initialization.

Initial + retry 1 + retry 2 only. After retry 2 restore product/prompt preimages, keep the master ledger status/evidence append-only, and update the failure log.

## Evidence and next

Record route inventory, auth responses, export headers, dbPath mtime, temp fingerprints and startup/health behavior. Next is Batch 02 only when no normal route calls writeDB and all 01B gates are green.
