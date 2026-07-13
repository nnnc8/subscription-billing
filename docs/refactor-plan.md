# Subscription Billing 重構計畫

更新日：2026-07-11

## 目的與不變條件

這次重構要降低修改帳務系統時的風險，不追求漂亮的檔案數字。完成後，API、UI、SQLite 資料、帳期自動推進、備份還原、AI 自動化與 launchd/Docker 啟動方式都必須維持可用。

全程遵守下列條件：

- 正式資料只由 SQLite 提供；JSON 僅保留明確的匯入或匯出用途。
- `Asia/Taipei` 是帳期判定時區；歷史月份唯讀，正常 UI 不提供手動跳月。
- 不清理或批次加入 `backups/`，也不覆蓋本輪開始前的 Phase 0/1 未提交變更。
- 測試使用暫存 `DATA_DIR`，不得碰正式 `database.db` 或正式備份。
- AI 只負責解析與建議；帳務驗證、寫入、ledger 與備份仍由確定性程式處理。

## 基線

- `server.ts` 1,692 行，38 個 API routes；`src/App.jsx` 2,593 行、50 個 `useState`。
- 現有 74 個 Vitest tests、`pnpm verify`、lint、兩份 TypeScript 設定與 Vite build 皆可跑。
- 初始 JS bundle 為 663.06 kB（gzip 189.03 kB）。
- CI 尚未跑完整 test/typecheck；lint 有 28 warnings；後端開啟兩個加嚴型別選項時有 60 個錯誤。
- Phase 0/1 已開始改成 SQLite migration、repository、SQLite backup 與單一資料來源，但仍在未提交工作樹中。

## Batch 1：先修資料與安全風險

工作：

- 補齊所有 async persistence caller 的 `await` 或 `return`，讓失敗能進入 Express 5 error flow。
- 把 `/api/export-json` 放到登入保護之後。
- restore 覆寫 live DB 前先驗證來源，且安全備份失敗就停止。
- `writeDB` 在前置備份失敗時停止，不把「沒有備份」當作成功寫入。
- 500 response 不回傳內部錯誤細節。

驗收：

- 新增暫存 `DATA_DIR` 的成功寫入、寫入失敗與 restore 測試。
- `pnpm test`、`pnpm verify`、兩份 typecheck 全過。

回滾邊界：只涉及 `server.ts`、測試與必要的 persistence helper；不做路由搬移。

## Batch 2：拆後端，不改外部行為

工作：

- 先分離 `createApp()` 與 `startServer()`，讓測試 import app 時不會 listen、跑 migration 或推進帳期。
- 建立單一 runtime/context，集中資料路徑、DB 讀寫、備份與唯一一份 automation inbox。
- 搬出 CORS、auth、error middleware。
- 依真實邊界拆 routes：runtime/data、billing、settings/entities、lifecycle/audit、backup、AI/automation。
- 在 mutating 與高成本 AI 邊界使用 Zod；金額、成員存在性、帳期等 domain validation 保留在 domain 層。

驗收：

- 38 個既有 endpoint 的 method/path 不變，未知 `/api/*` 仍回 JSON 404。
- Express 5 直接處理 async route；不新增多餘的 `asyncHandler`。
- 暫存 server integration test 至少覆蓋每個 route group、auth gate、invalid payload、成功寫入與 persistence failure。
- 入口檔只負責載入 env、建立 runtime/app 與 listen；不以 `<80` 或每檔 `<200` 當作行數遊戲。

回滾邊界：先切 app factory，再逐 route group 搬；每次只搬一組並跑 integration tests。

## Batch 3：前端依產品邊界拆分並完成 TypeScript

工作：

- 先移除未使用的會議 template、inline base64 avatars 與可證明未引用的 CSS。
- 保留四個既有導航：總覽、訂閱名額、設定、歷史紀錄；不新增會改變資訊架構的 Members/Backup tabs。
- 建立 `DashboardTab.tsx` 與 `SettingsTab.tsx`，讓各自的 state、handlers 與 UI 一起搬移。
- 將 `AutomationTab.jsx`、`main.jsx`、`App.jsx` 轉成 TypeScript；共用型別繼續放在 `src/types/billing.ts`。
- 使用既有原生 fetch wrapper 與單一資料刷新流程；沒有 cache、分頁或輪詢需求前不加入 TanStack Query。
- 共用一個原生 `<dialog>` modal，導航與關閉控制改成 button，toast 補 `aria-live`。
- 只 lazy-load 真正延後使用的重型 AI/automation 區塊。

驗收：

- `src` 不再有 `.js/.jsx`，`allowJs:false`，前端 typecheck 無錯。
- `App.tsx` 只負責 auth、theme、active tab、主資料刷新與組裝；不把原 monolith 搬進單一巨型 hook。
- Vite 產生 deferred chunk，初始 gzip 不高於 189.03 kB。
- 四個導航頁、三種 dialog、Esc、焦點回復與 toast live region 有 browser smoke proof。

回滾邊界：template 清理、a11y、Dashboard、Settings、TS 收尾分批完成。

## Batch 4：簡化 AI 線路

工作：

- 移除 Portkey、Vertex fallback、hardcoded GCP project id 與 debug spam。
- `lib/ai.ts` 成為共用 Gemini AI Studio transport，集中 API key、model、request、embedding 與錯誤處理。
- reminder、RAG、assistant、automation 共用 transport；各自保留 tool payload 與 response parsing。
- 不建立只有一個 implementation 的 `AiProvider` interface。

驗收：

- `lib/` 無 `portkey`、Vertex endpoint、hardcoded project id 或非必要 `console.log`。
- reminder/RAG/assistant/automation 的 mock-fetch contract tests 全過；不呼叫付費 API。
- AI 未設定或遠端失敗時，原本可用的 deterministic fallback 仍可用。

回滾邊界：先共用 transport，再一次遷移一條 caller。

## Batch 5：品質門檻與維運

工作：

- 加入 `typecheck`，修完 `noUncheckedIndexedAccess` 與 `exactOptionalPropertyTypes` 造成的真實錯誤。
- 將 lint warnings 清零，`no-explicit-any` 與 unused vars 變成 CI errors。
- `pnpm verify` 統一執行 lint、typecheck、完整 tests 與 build；CI 只重用這個入口，再做 Docker build。
- 量測 coverage 後設定不倒退門檻；不先拍腦袋指定 60%。
- Docker 使用 non-root user，Node 內建 fetch healthcheck 打 `/api/health`；`/data` 權限可寫。
- 修正 `start.sh`、靜態 plist、setup 與 README，使它們都指向 `server.ts`、pnpm 與 `DATA_DIR`。

驗收：

- `pnpm verify` 單一命令全過，CI 配置沒有繞過它。
- `git diff --check` 全過。
- 有 Docker 的環境驗證 non-root、health 200、DB/backup 在 `/data`、重啟後資料仍在；本機沒有 Docker 時明確保留未驗證項目。
- README 的架構、資料目錄、備份、API、local/launchd/Docker 操作與實作一致。

## 最終完成條件

- 所有既有與新增 tests、lint、strict typecheck、build、verify 全過。
- 使用暫存資料做一次真 server smoke；使用 browser 做登入後主要流程 smoke。
- fresh-context review 檢查資料遺失、auth/CORS、restore、帳期、AI fallback、a11y 與部署文件。
- 最終回報列出已驗證證據、無法在本機驗證的項目，以及本輪沒有納入的使用者資料。

