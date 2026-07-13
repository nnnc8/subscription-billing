# Handoff to Luna

## 已證實

- repo：`/Users/nc8/subscription-billing`
- project：`Users-nc8-subscription-billing`，Codebase MCP index ready
- branch：dirty `main`
- baseline HEAD：`6028913dd95e`
- 38 route method/path integration inventory 存在且現有 tests 綠
- current test baseline：11 files / 94 tests passed
- legacy `pnpm run verify` passed
- app/node typecheck passed under current non-hardened configs
- current backend has runtime/app/route/repository split
- four navigation labels and hidden sections exist
- Gemini transport has centralized AI Studio request and key redaction
- Docker uses non-root `node` and `/data` volume in compose
- LaunchAgent template points at `tsx server.ts`

## 尚未證實，不能當完成

- durable queue and same-connection canonical projection validation
- concurrent payment/temp-charge preservation
- migration/restore/delete failure-atomic behavior for all failure branches
- export attachment without `database.json` write
- startup fail-closed / health 503 after runtime failure
- proxy/CORS/OAuth public-origin trust boundary
- AI schema, timeout, caller cancellation and paid live proof
- permanent AI/Automation mounting and DOM/browser state/focus/Esc proof
- hardened TypeScript flags and lint zero
- coverage floor, unified `pnpm verify`, bundle gate and CI SHA
- Docker healthy authenticated native-fetch/recreate smoke
- installed LaunchAgent cutover, live port/health, correct DATA_DIR

## 首個入口

先執行：

```text
docs/luna-plan/prompts/01a-durable-save-and-mutation-queue.md
```

不是先改 UI、README、Docker 或 LaunchAgent。資料 safety 是所有後續 batch 的前置條件。

## Dirty ownership

本次開始前 working tree 已有大量 Phase 2–6 變更，包括：

- deleted legacy `.cjs`/`.jsx` files；
- new `server/`、repositories、TS frontend、tests；
- modified package/lock, Docker, plist template, scripts；
- untracked `docs/refactor-plan.md` 與 new source/test files。

這些不是 Luna 本輪可任意覆蓋的空白。每批只觸碰 prompt 的 write set，保留其他 dirty changes；不 switch/stage/commit/reset/checkout/clean。

## 正式資料禁區

禁止：

- `database.db`, `database.db-wal`, `database.db-shm`
- `backups/`
- `.env` / credential
- installed `~/Library/LaunchAgents/com.nc8.subscription-billing.plist`
- Docker production volume
- paid Gemini request

測試一律 temp `DATA_DIR` + dynamic port + dummy auth/key。

## 五大回歸

1. payment/temp-charge concurrent writes 少一筆或重複一筆；
2. failed save/restore/migration 改變 live fingerprint；
3. history/active-month 被誤寫或手動跳回；
4. 401、dialog focus/Esc、tab state、toast 回歸；
5. template/CI/config 看似正確但 installed/runtime/Docker 仍不可用。

## 最小升級包

需要明確詢問使用者才可開始：

- commit/push 或等待 GitHub job；
- paid Gemini key 與成本授權；
- installed LaunchAgent credential rotation/re-scope/cutover；
- Docker production volume 或正式 DB 操作；
- production deployment。

## 交接回報

```text
batch/status:
changed files:
tests and counts:
runtime proof level:
known unknowns:
failure/rollback:
next exact prompt:
```

若 Luna 不能取得要求的 model/effort selector，回報 `selector unavailable`；不可把 prompt 文字當成 runtime proof。
