# 08 — Operator-only runtime closure

## Mission

Close installed LaunchAgent, local runtime and authenticated browser behavior without unattended service, credential or production-data mutation.

## Preconditions

- The runner must prepend or read docs/luna-plan/02-luna-runbook.md; direct invocation without it is invalid.

- 07 is verified_complete.
- First action is redacted read-only capture.
- This prompt must stop before any installed plist, credential, service state, browser session or paid key change unless the user gives explicit authorization in the current task.

## Exact write set

Before authorization: none. Read-only capture only.  
After explicit authorization: only the installed plist backup under /Users/nc8/.codex/agent-guide-backups or a user-approved operator backup directory, the installed ~/Library/LaunchAgents/com.nc8.subscription-billing.plist, and the exact project operator file named in the authorization. Never write credentials to the repo.

## Checks and read-only capture

~~~bash
installed="$HOME/Library/LaunchAgents/com.nc8.subscription-billing.plist"
plutil -extract WorkingDirectory xml1 -o - "$installed"
plutil -extract EnvironmentVariables.PORT xml1 -o - "$installed"
plutil -extract EnvironmentVariables.DATA_DIR xml1 -o - "$installed"
plutil -extract ProgramArguments json -o - "$installed" | jq -r 'map(if endswith("/server.ts") then "server.ts" elif endswith("/server.cjs") then "server.cjs" elif endswith("/cli.mjs") then "tsx-cli" elif endswith("/node") then "node" else "[redacted]" end) | @json'
port=$(plutil -extract EnvironmentVariables.PORT raw -o - "$installed" 2>/dev/null || printf '3000')
launchctl print "gui/$(id -u)/com.nc8.subscription-billing" | rg '^([[:space:]]*pid|[[:space:]]*state|[[:space:]]*active count|[[:space:]]*program|[[:space:]]*path|[[:space:]]*last exit code)'
pid=$(launchctl print "gui/$(id -u)/com.nc8.subscription-billing" | awk '/^[[:space:]]*pid =/{print $3; exit}')
test -z "$pid" || ps -p "$pid" -o pid=,ppid=,state=,comm=
test -z "$pid" || lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN
~~~

Do not run system-wide process listings or emit raw ProgramArguments. The jq projection above is the only allowed argv output. Redact tokens, cookies, inherited environment and private paths not needed for proof. Record whether installed args are node + tsx + server.ts, active count, last exit, port and DATA_DIR; the listener must belong to the LaunchAgent PID.

## Required decision gates

1. Confirm owner and blast radius of inherited credentials and other services.
2. Separate credential rotation/re-scope from service cutover.
3. If new service fails, leave it stopped and retain old plist; never restart known crash-loop server.cjs.
4. After authorization only, back up installed plist, install/cut over, then verify active=1, correct args, port/health, correct DATA_DIR and no new MODULE_NOT_FOUND.
5. Use temp DATA_DIR for authenticated browser smoke: four navigation surfaces, state retention, three dialogs, real Esc, focus return and toast.
6. Paid Gemini smoke requires a separate reversible key and cost authorization; otherwise record mock-only.

## Failure, retry and rollback

Attempt limit: initial run, retry 1 and retry 2 only; each retry requires a new falsifiable hypothesis. Installed plist/service state is operator state, not a product preimage: after retry 2 retain the authorized plist backup, leave a failed new service stopped, and restore the installed plist only after explicit operator approval. Verify launchctl state, port/health and log delta after any operator-approved restore; keep the master ledger status/evidence append-only.

Any unknown credential owner, unexpected service dependency, incorrect DATA_DIR, health failure, browser regression or new error stops the run. Keep the backup and restore the installed plist only with explicit operator approval. Do not claim rollback success until launchctl and logs prove it.

## Evidence and next

Record redacted plist args, launchctl state, process/port/health, DATA_DIR marker, browser actions and log delta. The next entry is 99 only after operator proof is complete; if authorization is absent, mark 08 operator_only with exact missing authority.
