# Luna Runbook

## 第一分鐘

1. Read `docs/luna-plan/00-current-state-audit.md` and `01-master-plan.md`.
2. Run read-only capability probe. First repo discovery call must be exposed `codebase-memory-mcp.list_projects`; never initialize a new index without authorization.
3. Confirm project `Users-nc8-subscription-billing` is indexed and ready. Use structural search, trace, snippets and change detection before broad `rg`.
4. Record branch, SHA, dirty status, exact write set and forbidden set.
5. Check whether the target `docs/luna-plan` already exists. If it did before this documentation run, exclude any `backups/` and copy existing files to `docs/luna-plan/backups/<timestamp>/` before replacement.
6. Confirm all product/integration tests will use temp `DATA_DIR`, dynamic port and dummy credentials.
7. Start only the next pending batch. Do not run 08 unattended.

## Routing

Preferred order:

```text
list_projects
→ index_status
→ search_graph / trace_path / get_code_snippet
→ targeted rg/direct read for exact text, logs, generated files, configs
→ targeted test
→ full gate
→ diff/read-back
```

If Codebase MCP is unavailable or project is not indexed, record the failure and use narrow `rg`/direct reads. Do not build an index as a workaround.

## Luna CLI

The collaboration surface may not expose model/effort selectors. A prompt label never changes the runtime model. When explicit Luna is needed and the local CLI supports it:

```bash
PROMPT=docs/luna-plan/prompts/01a-durable-save-and-mutation-queue.md
LOG="/tmp/luna-01a-$(date +%Y%m%d-%H%M%S).jsonl"
codex exec \
  -C /Users/nc8/subscription-billing \
  -m gpt-5.6-luna \
  -c 'model_reasoning_effort="xhigh"' \
  -s workspace-write \
  --json - \
  < "$PROMPT" \
  > "$LOG"
```

Each prompt is self-contained, but the runner must first read 00-current-state-audit.md, 01-master-plan.md and this runbook. If using a single stdin stream, prepend those files before PROMPT and preserve the prompt path in the log metadata.

From the same log, inspect event names before parsing model/effort. The event shape is CLI-version dependent:

```bash
jq -r 'select(.type != null) | .type' "$LOG" | sort -u
jq -r 'select(.type=="thread.started") | .thread_id' "$LOG"
jq -r 'select(.type=="turn_context" and ((.payload.model? // null) != null or (.payload.effort? // null) != null)) | [.payload.model,.payload.effort] | @tsv' "$LOG"
```

The run is invalid for a Luna-specific claim if the current CLI has no supported model/effort event or the read-back differs from `gpt-5.6-luna	xhigh`. Do not assume turn_context exists; if the current event schema differs, use its documented model/effort fields or mark the selector proof unknown. Do not use `--ephemeral`; preserve the rollout trace. If quota/model read-back fails, classify it as harness evidence failure, not a product retry.

## Fixed batch loop

Before editing, snapshot every existing product/prompt write-set path, including untracked files, to /tmp/luna-rollback/<batch>-<timestamp>/ and record sha256. The master plan status/evidence hunk is append-only and is excluded from preimage restoration. This is required because git diff has no preimage for an untracked file.

For each batch:

1. Baseline: read current files and run the narrow pre-check.
2. Edit only the prompt write set.
3. Run targeted tests using temp data.
4. Run the closest full gate (`pnpm test --run`, typecheck, lint, verify, build, or Docker smoke as applicable).
5. Inspect diff and read every saved file back.
6. Update the master status/evidence entry.
7. Stop before the next batch if a required proof is missing.

## Retry policy

At most three attempts total: initial, retry 1, retry 2. Every retry must state a falsifiable new hypothesis. Examples:

- “The failure is queue ordering” is not enough; test both concurrent enqueue and a rejected predecessor.
- “Docker is missing files” must identify the image path and inspect it as non-root.
- “The browser lost state” must record mount/unmount and DOM value after navigation.

After retry 2, restore product/prompt preimages, keep the master plan status/evidence append-only, verify hashes, preserve failure trace, and hand off to the specified reviewer. No third retry.

## Safety gates

- Never use production `DATA_DIR`, `database.db`, `database.db-wal`, `database.db-shm`, `backups/`, `.env`, Docker production volume or paid Gemini.
- Never send raw secrets to logs, plans, prompts or reviewers.
- Never stage, commit, reset, checkout, clean or switch branch.
- Never claim “working” from a written config, installed binary, registered MCP, green unit test, or old log alone.
- `08` must first capture redacted installed state, then stop for explicit user authorization before touching plist, credentials, service state or browser session.
- If rollback itself fails, retain the safety snapshot and escalate; do not delete evidence.

## Handoff format

```text
batch / status:
what changed:
what did not change:
tests:
runtime scope:
evidence:
failure trace:
rollback:
next exact entry:
```

## Final review

Use a fresh `fork_turns="none"` read-only reviewer against the actual `docs/luna-plan/**` and current repo. Reviewer must check P0/P1 are zero; every P2 is fixed or listed in `01-master-plan.md` with an accepted reason. Then read each file back and verify batch numbers, links, write sets, commands and statuses agree.
