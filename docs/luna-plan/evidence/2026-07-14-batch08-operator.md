# Batch 08 operator evidence — 2026-07-14

This is a redacted evidence summary. It contains no credentials, cookies, account payloads or raw service logs.

## Authorization and scope

- Authorization: current task explicitly authorized installed plist backup, credential review, service cutover and temp `DATA_DIR` browser smoke.
- Paid Gemini: not authorized; mock-only.
- Credential rotation/re-scope: not performed; it is a separate operator decision.
- Repository SHA observed during runtime proof: `10573c39970db0859f19d287ebfd970c447d6969`.

## Installed runtime

- Backup: `/Users/nc8/.codex/agent-guide-backups/subscription-billing-launchagent-20260714-002854/com.nc8.subscription-billing.plist`
- Backup SHA256: `900fab9ea55730e43bcfe951f4d453663e10a0941be9f5620a68bd076dfe16fd`
- Installed argv projection: `node + tsx-cli + server.ts`
- Installed `DATA_DIR`: `/Users/nc8/subscription-billing`
- LaunchAgent: `active count=1`, `state=running`, PID `99560`, last exit `(never exited)`
- Listener: port `3000`, PID `99586`, parent PID `99560`; the listener is the tsx child in the LaunchAgent process tree.
- `/api/health`: `ok=true`, `authConfigured=true`, `dataWritable=true`, `host=127.0.0.1`, `port=3000`, `readiness=ready`
- Unauthenticated `/api/data`: HTTP `401`
- Five-second post-cutover delta: `server.err=0`, `server.log=0`, new `MODULE_NOT_FOUND=0`

## Credential review

- Installed plist exposed only redacted `PATH`, `DATA_DIR` and `PORT` values; no sensitive key was embedded in the plist.
- Inherited GUI launchd credential-like names were reviewed by key name and owner scope only; no raw value was persisted, repeated or written to the repo.
- Matching sensitive key names were not found in other LaunchAgent plist files during the review.

## Temporary browser smoke

- Local `agent-browser` with a dummy signed session; app port `43127`, one-shot local cookie bootstrap port `43128`.
- Temporary `DATA_DIR`: `/tmp/subscription-billing-b08.cG1cKE`; removed after the smoke.
- Four navigation surfaces passed.
- Retained across navigation: Dashboard filter `B08-DASH-FILTER`, Settings draft `B08-SETTING-DRAFT`, History month `2026/06`, Automation input `B08-AUTOMATION-INPUT` and a mock pending-proposal filter.
- Payment, temp-charge and restore dialogs opened; real Escape closed each; opener focus returned; a `role=status` toast appeared.
- The browser session, cookie bootstrap, temp server, temp data and temp logs were cleaned up.

## Disposition

Batch 08 operator proof is `verified_complete`. The next exact entry is `prompts/99-completion-audit.md`; paid AI remains mock-only.
