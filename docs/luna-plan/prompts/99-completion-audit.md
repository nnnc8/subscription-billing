# 99 — Completion audit

## Mission

Prove the full objective requirement by requirement. This is an audit, not a cleanup pass and not a license to redefine success around green unit tests.

## Preconditions

- The runner must prepend or read docs/luna-plan/02-luna-runbook.md; direct invocation without it is invalid.

- Read every file under docs/luna-plan and the current repo state.
- All earlier batches have status and evidence; 08 may remain operator_only only with an explicit missing-authority record.
- Use a fresh fork_turns="none" reviewer for independent review.

## Exact write set

- docs/luna-plan/00-current-state-audit.md
- docs/luna-plan/01-master-plan.md
- docs/luna-plan/04-maintenance-protocol.md
- docs/luna-plan/05-handoff-to-luna.md
- docs/luna-plan/prompts/99-completion-audit.md

No product, dependency, service, git index, DB, backup, secret or installed plist writes.

## Audit matrix

For each item, mark achieved / contradicted / incomplete / unknown and cite authoritative evidence:

- all 38 method/path pairs and response compatibility;
- durable queue, canonical projection, concurrency and queue recovery;
- migration/restore/delete failure atomicity and retention boundaries;
- export attachment and no database.json write;
- startup readiness and health 503;
- trust proxy/CORS/PUBLIC_ORIGIN/OAuth/AI schema-timeout-cancellation;
- four navigation, mounted AI/Automation, apiFetch, 401/dialog/focus/toast/DOM/browser;
- strict compiler, lint zero, full tests, coverage thresholds and build;
- one pnpm verify path, CI Node 22/24 and exact successful SHA;
- manifest/bundle budget and dynamic AI/Automation;
- Docker build/healthy/non-root/authenticated persistence/recreate;
- README alignment;
- installed LaunchAgent/runtime/port/health/DATA_DIR and browser smoke;
- paid AI proof or explicit mock-only.

## Checks

~~~bash
git status --short --untracked-files=all
pnpm verify
git diff --check
~~~

Do not rerun destructive or operator-only commands without their required authorization. Read back every saved planning file and check that batch numbers, links, write sets, commands, statuses and evidence agree.

## Reviewer contract

Reviewer returns:

~~~text
severity | file | finding | evidence | required action
~~~

P0 and P1 must be zero. Every P2 is fixed or listed in 01-master-plan.md with a concrete accepted reason. Re-run the reviewer after fixes.

## Failure, retry and rollback

Attempt limit: initial run, retry 1 and retry 2 only; each retry requires a new falsifiable hypothesis. After retry 2, restore product/prompt preimages, keep the master ledger status/evidence append-only, verify hashes and stop.

If any requirement is incomplete, keep the goal active and record the exact missing evidence. Retry only after a new falsifiable audit question or a documentation correction. Do not modify product files to make the audit pass. Restore only a non-ledger audit documentation hunk if it introduces an incorrect claim; preserve the master ledger status/evidence append-only.

## Evidence and next

Record the audit matrix, fresh-review result, exact commands, SHA/runtime scope and every unknown. The next entry is the exact incomplete requirement, not a smaller substitute. Mark verified_complete only after the matrix has no incomplete or unknown required item.

## Completion rule

Call verified_complete only if every explicit requirement has matching current evidence. If an item is missing, keep the plan active and state the exact next action. “Tests pass”, “installed”, “configured”, “template points correctly” or “no obvious issue” cannot substitute for running/live proof.
