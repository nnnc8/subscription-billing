# 02 — Backup、restore、migration failure-atomic

## Mission

Make existing SQLite migration, backup, restore and delete safe under every tested failure branch. Live DB must remain unchanged unless stage validation and post-verify succeed.

## Preconditions

- The runner must prepend or read docs/luna-plan/02-luna-runbook.md; direct invocation without it is invalid.

- 01A and 01B verified_complete.
- Read current migration and backup call graph before editing.
- All tests use temp DATA_DIR and isolated backup directories.

## Exact write set

- lib/db.ts
- server/runtime.ts
- server/services/backup.ts
- server/routes/backup.ts
- tests/db-lifecycle.test.ts
- tests/server.integration.test.ts
- tests/db-atomicity.test.ts (new if needed)
- server.ts (startup await/readiness boundary; existing boundary read-back or exact edit only if required by this batch)
- tests/mutation-queue.test.ts (legacy adapter removal/read-back; exact edit only if required by this batch)
- docs/luna-plan/01-master-plan.md (status/evidence only)

Do not modify frontend, AI, package/lock, Docker, CI, installed plist or real DB.

## Required implementation

1. Existing DB migration: live → hidden stage; run all pending migrations, integrity/load/domain validation; create non-rotating safety snapshot; use SQLite Online Backup once from stage to live; post-verify before cleanup.
2. Restore: backup → hidden stage; append restore ledger on stage; save and validate stage; Online Backup stage → live. Never rm + rename over existing live SQLite/WAL/SHM.
3. Bootstrap JSON is the only case allowed to same-directory rename when target did not exist.
4. On rollback or post-verify failure, retain safety snapshot. Delete it only after success or verified rollback.
5. Delete backup by same-directory rename to hidden tombstone; ledger failure renames back. Ledger success plus unlink failure is cleanup-pending, not a falsely reported total failure. Startup resolves tombstones using matching ledger.
6. Stage, safety and tombstone files never enter 50-file regular rotation.
7. Add test-only migrationsDir injection and fail at migration N; live fingerprint must remain identical.

Commit point: live is untouched until stage migration, integrity, load and domain validation pass. The stage → live Online Backup is the commit. After that commit, live post-verify must pass; if it fails, restore the retained safety snapshot and delete it only after rollback verification. A post-verify failure is therefore a rollback path, never a cleanup success.

## Checks

~~~bash
pnpm test --run tests/db-lifecycle.test.ts tests/db-atomicity.test.ts tests/server.integration.test.ts
pnpm run verify
~~~

Test at least: migration failure, stage validation failure, stage→live failure, post-verify failure, restore failure, rollback failure, delete ledger failure, cleanup-pending restart and retention boundary.

## Failure, retry and rollback

Attempt limit: initial run, retry 1 and retry 2 only; each retry requires a new falsifiable hypothesis. After retry 2, restore product/prompt preimages, keep the master ledger status/evidence append-only, verify hashes and stop.

If any branch deletes a safety/stage/tombstone artifact before proof, stop and restore only product/prompt preimages. Never “fix” failure atomicity with a live rm + rename. Snapshot and hash all existing product/prompt write-set paths before attempt 1, including untracked test files; keep the master ledger status/evidence append-only; after retry 2 restore product/prompt preimages. If rollback cannot be proven, record a blocked condition for operator review; reserve batch status `blocked` for the canonical three-consecutive-goal-turn threshold.

## Evidence and next

Record live/stage/safety fingerprints, directory listings, retention counts, ledger events and cleanup decisions. Next is 03 only after every failure branch is either atomic or explicitly retained for review.
