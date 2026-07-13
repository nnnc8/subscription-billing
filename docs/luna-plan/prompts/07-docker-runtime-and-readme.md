# 07 — Docker live smoke 與 README

## Mission

Make the final image runnable and document the actual app/runtime/routes/data/backup/AI/launchd/Docker behavior. Static Docker success is not live smoke.

## Preconditions

- The runner must prepend or read docs/luna-plan/02-luna-runbook.md; direct invocation without it is invalid.

- 06 is verified_complete.
- Docker availability is checked read-only.
- Use dummy auth, ephemeral named volume and dynamic host port.

## Exact write set

- Dockerfile
- .dockerignore
- docker-compose.yml
- README.md
- scripts/docker-smoke.sh (new if needed)
- docs/luna-plan/01-master-plan.md (status/evidence only)

Do not modify application source, package/lock, CI beyond the dependency already defined in 06, installed plist or production volume.

## Required implementation

1. Docker final stage includes server/ as well as the built app, lib and scripts required by tsx runtime.
2. .dockerignore adds *.err while retaining DB/WAL/SHM/backups/data protection.
3. Use an ephemeral named volume and a trap that always removes container and volume.
4. Smoke: build → healthy → UID is not 0 → authenticated native-fetch creates member/payment/backup → prove data only exists under /data → recreate with same volume → marker and backup remain.
5. Health uses /api/health and startup failures are visible.
6. README matches current TS paths, runtime routes, AI Studio-only boundary, DATA_DIR, backup policy, 38 routes, verify, Docker and launchd. Remove stale Vertex, App.jsx and AutomationTab.jsx descriptions.

## Checks

~~~bash
docker compose build
docker compose run --rm --no-deps billing node --version
scripts/docker-smoke.sh
~~~

If Docker is unavailable locally, do not fake live proof. A successful GitHub job URL after an authorized commit/push is the only substitute.

## Failure, retry and rollback

Attempt limit: initial run, retry 1 and retry 2 only; each retry requires a new falsifiable hypothesis. After retry 2, restore product/prompt preimages, keep the master ledger status/evidence append-only, verify hashes and stop.

If container starts but authenticated writes do not persist, inspect volume path and runtime copy set; do not relax auth or write to project root. If recreate loses marker/backup, stop at volume semantics. If README conflicts with source, update README only after runtime evidence.

## Evidence and next

Record image digest, container UID, health response, authenticated operation responses, /data listing, recreate marker/backup and README read-back. Next is 08, which remains operator-only.
