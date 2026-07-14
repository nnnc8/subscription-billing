# Luna 現況稽核

更新日：2026-07-14
稽核基準：`main` / `6028913dd95e` / working tree  
Codebase MCP project：`Users-nc8-subscription-billing`  
Scope：本套件只規劃未來執行；本次交付不得改產品、依賴、服務、正式資料、git index、backup 或 secrets。

## 裁定

目前不是「重寫整個產品」；是把已完成一部分的 Phase 2–6 工作，收斂成可回滾、可證明的 9 個 delivery batches，另有 99 completion audit prompt。最先處理資料安全與 durable mutation，再處理 trust、UI、品質門檻、部署，最後才做 operator-only runtime closure。

`docs/refactor-plan.md` 是前一版計畫，不是本套件的執行真相。Luna 只能以本檔、live repo、當回合工具輸出與實際 test/runtime evidence 為準。

## 已核對的 live evidence

| 項目 | 現況 | 證據 |
|---|---|---|
| indexed repo | 2026-07-13 baseline observed ready with 1220 nodes / 2647 edges; the main runner's current 2026-07-14 direct `list_projects` probe returned `Transport closed`, so no current subscription-billing project listing is available and no index was initialized in this execution | baseline `mcp__codebase_memory_mcp__list_projects`/`index_status`, 2026-07-13; current direct capability probe, 2026-07-14 |
| evidence capture | redacted read-only baseline saved | `docs/luna-plan/evidence/2026-07-13-baseline.md` |
| branch / HEAD | dirty `main`、`6028913dd95e` | `git branch --show-current`、`git rev-parse --short=12 HEAD` |
| pre-delivery Luna directory | 建立前不存在；本次已建立；無需備份既有規劃檔 | `test -d docs/luna-plan` before write；本檔完成後 `find docs/luna-plan` |
| dirty ownership | 原有 Phase 2–6 變更共 84 個 status entries；另有未提交 `docs/refactor-plan.md` 與新 TS/route/repository/test 檔 | `git status --short --untracked-files=all` |
| route parity | 38 個 method/path pair 的 integration assertion 存在並通過 | `tests/server.integration.test.ts:117-158`、`pnpm test --run` |
| tests | 11 files、94 tests passed | `pnpm test --run`，2026-07-13 |
| legacy verify | passed | `pnpm run verify`，2026-07-13 |
| app/node typecheck | passed；尚未代表 hardened flags 已開啟 | `pnpm exec tsc --noEmit -p tsconfig.app.json`、`tsconfig.node.json` |
| lint | 5 warnings；一般 lint exit 0，但 `--max-warnings=0` exit 1 | `pnpm lint`、`pnpm exec eslint . --max-warnings=0` |
| verify contract | 只跑 auth/privacy/accounting/rollover/portability；沒有 lint、typecheck、coverage、build | `package.json:10-22` |
| CI | `verify`、lint、build 分開；Docker job 沒有 `needs: verify` 且只 build | `.github/workflows/verify.yml` |
| runtime split | `server.ts` 41 行；`server/app.ts`、`server/runtime.ts`、7 route groups 已存在 | live files、Codebase MCP architecture |
| persistence seam | `writeDB` 先 backup、再 `saveToSQLite`；沒有 fresh-state queue 或 canonical projection read-back | `server/runtime.ts:123-137`、`lib/db.ts:136-172` |
| export | `/api/export-json` 仍把 JSON 寫回 `runtime.paths.dbPath`，不是 attachment | `server/routes/data.ts:11-18` |
| trust / CORS | Express `trust proxy` 無條件為 `true`；CORS 會從 request forwarded headers 組 origin | `server/app.ts:23-25`、`server/middleware/cors.ts:20-38` |
| AI transport | Gemini AI Studio transport 已集中、會 redact key；尚無 caller schema、timeout、caller cancellation | `lib/ai.ts:58-99` |
| frontend | 四導航與 hidden sections 已存在；AI/Automation 仍在 Dashboard active 時才 lazy mount；Automation mutation 使用 raw `fetch` | `src/App.tsx:172-183`、`src/components/DashboardTab.tsx:30-31,495-498`、`src/components/AutomationTab.tsx:324,358,379` |
| Docker | final image COPY `lib/`、`scripts/`，但未 COPY `server/`；`.dockerignore` 未排除 `*.err` | `Dockerfile:13-29`、`.dockerignore:1-17` |
| installed LaunchAgent | ProgramArguments 仍是 `node .../server.cjs`；`server.cjs` 已被 working tree 刪除；`launchctl` 顯示 `last exit code = 1`；`server.err` 為 `MODULE_NOT_FOUND` | installed plist、`launchctl print`、`server.err` |
| port live state | 此次唯讀 probe 未見 3000 listener | `lsof -nP -iTCP:3000 -sTCP:LISTEN` |

## Phase 2–6 狀態

### Phase 2 — backend split：結構大致完成，安全 closure 未完成

已證實：app/runtime 分離、auth/CORS/error middleware、route groups、SQLite repositories、38 route parity test。未證實：所有 mutation 都經 fresh-state queue、startup readiness fail-closed、restore/migration failure-atomic、export 不寫 JSON、live 服務可用。

### Phase 3 — TypeScript / navigation：靜態 split 完成，DOM/browser proof 未完成

已證實：`src/App.tsx`、四導航、`allowJs: false`、tab sections。未完成：AI/Automation 第一次進入後永久 mounted、Automation 介面使用 `{ active, apiFetch, onDataChange }`、帳務 API 不繞過 `apiFetch`、DOM state/dialog/401/focus tests、真鍵盤 Esc browser proof。

### Phase 4 — Gemini transport：薄 transport 靜態完成，runtime boundary 未完成

已證實：AI Studio base URL、集中 key/model/request、HTTP error key redaction、caller contract tests。未完成：unknown JSON 以 caller-provided Zod schema 驗證、20 秒 timeout、caller cancellation、paid live proof。不得新增單實作 `AiProvider`。

### Phase 5 — strict type / lint / verify：未完成

目前兩份 typecheck 綠，是因 hardened compiler flags 尚未開啟。lint 有 5 warnings，`--max-warnings=0` 失敗；`pnpm verify` 仍未包含完整 quality pipeline。coverage、build、CI unified gate 尚未完成。

### Phase 6 — deploy / operator：靜態部分完成，live closure 未完成

已證實：Docker non-root、`/data` volume、healthcheck、LaunchAgent template 指向 `tsx server.ts`。未完成：Docker final image 的 `server/`、Docker live smoke/recreate、README 與 live implementation 對齊、installed plist cutover、health/port/DATA_DIR/browser smoke。

## 三個最高風險

1. **durability race / partial write**：`writeDB` 接受 caller 讀出的 mutable snapshot，backup、save、read-back 不在同一 durable protocol；並行付款或 lifecycle catch-up 可能遺失更新。
2. **restore/migration failure-atomic 不足**：migration 直接作用 live SQLite；restore 先覆寫 live，再在後續 write 失敗時嘗試 rollback；safety snapshot 在 rollback 仍失敗時可能被清掉；delete 先 unlink 再寫 ledger。
3. **運行環境誤判為已修好**：installed LaunchAgent 仍啟動已刪除的 `server.cjs`，Docker image 也漏 `server/`。設定檔或 template 綠燈都不等於 installed/running/live success。

## 不變條件與禁區

- 正式資料只以 SQLite 為 canonical；JSON 只可作明確 import/export。
- `Asia/Taipei` 是帳期判定時區；active month 可編輯，歷史月份唯讀；正常 UI 不提供手動跳回舊月份。
- 每一筆 mutation 要保留 ledger、domain integrity、duplicate detection、member/subscription identity 與 current period invariants。
- 所有測試用 temp `DATA_DIR`、dynamic port、fake/dummy credential；不得碰正式 `database.db`、WAL/SHM、`backups/`、Docker 正式 volume、`.env`、installed plist 或 paid API。
- 不 switch branch、stage、commit、reset、checkout、clean；不得覆蓋本輪開始前 dirty changes。
- 本次交付 write set 僅 `docs/luna-plan/**`。若要執行 prompt 內產品變更，必須是另一次明確授權。

## 外部狀態：2026-07-13 baseline 尚未算完成

- `gpt-5.6-luna` 的當回合 quota/model read-back 未在本 session 重試；collaboration surface 若沒有 selector，不可用 prompt label 假裝切模。
- installed LaunchAgent 尚未取得 rotation/cutover 授權。
- paid Gemini key、成本與可撤銷測試 authorization 未取得；目前只算 mock-only。
- Docker host/GitHub job、authenticated browser smoke、production DB 與 production backup 未驗。

## Current execution delta — 2026-07-14

Batch 08 的 operator authorization 已取得並完成。Installed LaunchAgent 已由已刪除的 `server.cjs` cut over 到 `node + tsx + server.ts`；redacted credential review 沒有發現 installed plist 內嵌敏感 key，且未做 credential rotation/re-scope。LaunchAgent active count 為 1，`/api/health` readiness 為 ready，`/api/data` 未登入回 401，DATA_DIR 為 project root，listener 是 LaunchAgent tsx child process，cutover 後 5 秒無新增 error 或 `MODULE_NOT_FOUND`。

Temp DATA_DIR 的 authenticated browser smoke 已通過四導航、state retention、Automation mock filter、payment/temp-charge/restore 三個 dialogs、真 Esc、opener focus return 與 toast。Paid Gemini 沒有執行，仍是 mock-only；temp server、dummy session、temp data、browser session 已清理。Batch 08 現在為 `verified_complete`；99 在使用者明確授權 historical reconstruction exception 後由 fresh reviewer PASS，P0/P1/P2 均為零。

## 舊計畫 traceability

| 舊計畫要求 | Luna 裁定 |
|---|---|
| 先處理 async persistence、auth、restore | 保留，但拆成 01A/01B/02，先建立 durable protocol 再搬 route |
| backend split | 保留 route parity，不再用行數 KPI；Phase 2 的真正 gate 是 route、data safety、runtime |
| frontend TS / four navigation | 保留，補 mounted state、`apiFetch`、DOM/browser proof |
| Gemini shared transport | 保留，補 schema/timeout/cancellation；不加單實作 interface |
| strict type / lint / verify / coverage | 保留，coverage 以 measured baseline floor；不先拍固定百分比 |
| Docker / launchd / README | 保留，分開 static/configured/built/running/live；08 需 operator authorization |
| 38 routes | 以 current integration inventory 作為不變 contract，不刪 endpoint |

## Baseline 命令

```bash
git status --short --untracked-files=all
pnpm test --run
pnpm run verify
pnpm lint
pnpm exec eslint . --max-warnings=0
pnpm exec tsc --noEmit -p tsconfig.app.json
pnpm exec tsc --noEmit -p tsconfig.node.json
```

本檔的「已證實」只代表上述 live read-only evidence，不代表 9 個 delivery batches 或 99 audit 已完成。
