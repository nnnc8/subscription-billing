# 01A — Durable save、queue 與 billing exemplar

## Mission

把 payment 與 temp-charge 先搬進唯一的 durable mutation protocol。保留現有 route method/path、response shape、ledger、duplicate detection 與 active-month semantics。完成條件是 temp DATA_DIR 下的 concurrent writes、rollback、queue recovery 都有 evidence。

## Preconditions

- The runner must prepend or read docs/luna-plan/02-luna-runbook.md; direct invocation without it is invalid.

- Read docs/luna-plan/00-current-state-audit.md and 01-master-plan.md.
- Confirm Codebase MCP project is ready; use structural search before broad grep.
- Confirm working tree is dirty main and preserve all pre-existing changes.
- Confirm no production database, WAL/SHM, backups, .env or service is in scope.

## Exact write set

- server/runtime.ts
- lib/db.ts
- server/routes/shared.ts
- server/routes/billing.ts
- tests/mutation-queue.test.ts (new; do not substitute another test path)
- docs/luna-plan/01-master-plan.md (status/evidence only)

Do not modify package.json, lockfile, UI, Docker, CI, plist or unrelated tests.

## Required implementation

1. Add mutateDB<T>(mutator, options) as the only normal write API.
2. Queue worker performs fresh read → synchronous domain mutation/ledger → backup → transactional save/validation → RAG invalidation.
3. Reject Promise-like mutators before any backup or write.
4. In one SQLite transaction and before commit, read back through the same connection and compare the canonical projection: settings, lifecycle, platforms, members, subscriptions, payments, tempCharges, history and ledger.
5. Any projection mismatch, integrity failure, domain failure or persistence failure rolls back.
6. A rejected queue item must not poison the next item.
7. During transition, keep the `readDB` read-side legacy adapter with a WeakMap base fingerprint. This is not the write-side `writeDB` recovery adapter; if the caller snapshot differs from the current fresh fingerprint, fail closed without backup, write, merge or automatic retry. `writeDB` remains recovery-only until the 01B/02 cutover proves it can be removed.
8. Move only payment and temp-charge routes first. Network/AI awaits are not part of this queue.

## Invariants

- Existing 38 route pairs remain unchanged.
- Two parallel payments both survive with exactly one ledger event each.
- A forced transaction fault leaves the SQLite fingerprint unchanged.
- A failed item followed by a valid item produces the valid item.
- Tests use temp DATA_DIR and dynamic resources only.

## Checks

Run targeted checks first:

~~~bash
pnpm test --run tests/mutation-queue.test.ts tests/server.integration.test.ts
pnpm exec tsc --noEmit -p tsconfig.app.json
pnpm exec tsc --noEmit -p tsconfig.node.json
~~~

Then run:

~~~bash
pnpm test --run
pnpm run verify
~~~

Read back every changed file and inspect the diff. Do not claim verified_complete if the same-connection projection or concurrency proof is missing.

## Failure, retry and rollback

Attempt limit: initial run, retry 1 and retry 2 only; each retry requires a new falsifiable hypothesis. After retry 2, restore product/prompt preimages, keep the master ledger status/evidence append-only, verify hashes and stop.

Attempt 1: implement the smallest queue around existing repositories.  
Retry 1: if concurrency fails, isolate connection/serialization ordering and add a deterministic race test.  
Retry 2: if rollback fails, isolate transaction boundary and prove pre/post fingerprint.  
Before attempt 1, snapshot every existing product/prompt write-set path and hash it; keep the master ledger status/evidence append-only; for the new test file record an absent preimage. After retry 2, restore product/prompt preimages, verify hashes, retain the failure log, and stop.

## Evidence and next

Record exact SHA/dirty baseline, commands, test counts, temp DATA_DIR, before/after fingerprints, rollback result and path:line evidence in 01-master-plan.md. Next entry is 01B only after all 01A gates pass.
