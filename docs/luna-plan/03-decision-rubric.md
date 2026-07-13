# Luna Decision Rubric

這不是鼓勵 Luna 自行擴 scope 的授權；它是遇到不確定性時的停損規則。

## 直接修

可直接在當前 batch 修正，條件是：

- 完全落在 prompt 的 write set；
- 修正讓要求的 final state 更真實；
- 不碰正式資料、secrets、installed service 或 git index；
- 有可重現 test/command proof；
- 不改 38 route method/path 或 active-month product invariant。

Repo 例：在 01A 為 queue 寫 temp-data concurrency test；在 03 為已知 `trust proxy=true` 加預設 false 的 unit test；在 06 把 `pnpm verify` 串入已列明的 pipeline。

## 必須停下

遇到以下任一條，停在當前 batch 並回報：

- 需要新增 dependency，但不在該 batch write set；
- 需要碰正式 `DATA_DIR`、real OAuth/Gemini credential、installed plist、Docker production volume；
- 不知道 caller 期望的 route response 或 domain invariant；
- Codebase MCP 與 direct source 互相矛盾且尚未釐清；
- 修正會刪 route、改 method/path、允許歷史帳期寫入或吞掉 persistence failure；
- 測試只通過 mock，要求卻是 live/browser/runtime proof。

## 何時 rollback

對以下情況只恢復自己 batch 的 product/prompt preimages；master ledger status/evidence 永遠 append-only：

- canonical DB fingerprint 在 failure test 改變；
- concurrent mutation 少資料、重複 ledger 或 queue 被 rejected job poison；
- restore/migration post-verify 失敗又刪 safety snapshot；
- auth/CORS regression 讓 unauthenticated request 進入 data route；
- browser state、focus、Esc、toast 或 401 behavior 回歸；
- lint/typecheck/build gate 失敗且兩次新假設仍無法定位；
- Docker image/LaunchAgent static target 與 runtime target 不一致。

## 何時換路徑

可以換實作，不可換成功條件：

- `asyncHandler`、TanStack Query、Supertest、單實作 `AiProvider` 不是必要；若只為了通過測試，刪除這些提議而保留 behavior gate。
- 若 SQLite Online Backup API 的目前 wrapper 無法滿足 stage → live，先建立小型 adapter 或 test seam；不可退回 `rm + rename` 覆寫 live DB。
- 若 browser DOM test runner 與現有 Vitest 設定衝突，先隔離 jsdom/browser project；不可把 browser proof 改成 string snapshot。
- 若本機沒有 Docker，保留未驗證並把 live proof 移到成功 GitHub job；不可把 Dockerfile parse 當 healthy smoke。

## 何時可刪除相容行為

只有在以下條件全部成立才刪：

1. master plan 明確列該 adapter/legacy path；
2. 新 path 已有 fresh-state、rollback 與 route proof；
3. 正式 caller 已切換且沒有未知 consumer；
4. 失敗時 product/prompt preimage 可恢復且不抹掉 ledger；
5. 99 audit 有 evidence。

Repo 例：`writeDB` 只能在 01B、02 的 recovery adapter proof 完成後，才從一般 route 移除；不能因為 queue 已新增就直接刪。

## 何時升級或詢問使用者

- 需要 `gpt-5.6-luna` 但當前 surface 沒有 selector：記錄 `selector unavailable`，改由獨立 CLI 或保留未知，不假裝。
- 需要 commit/push、GitHub job、production deploy、paid AI、credential rotation、plist cutover：詢問並停止。
- 同一 external blocker 連續三個 goal turn，且沒有 temp/mock/read-only 替代：才可將 batch 標成 `blocked`。
- 若只是 task 很大、測試慢、或結果不確定，不得用 `blocked` 逃避；繼續做可逆的證據工作。

## Repo 反例

| 觀察 | 錯誤判斷 | 正確裁定 |
|---|---|---|
| `pnpm test` 綠 | 所有資料安全完成 | 只證明現有 suite；仍需 queue/restore fingerprint proof |
| plist template 指向 `server.ts` | LaunchAgent 已修好 | installed plist 仍是 `server.cjs`，08 operator-only |
| `server.ts` 很短 | backend refactor 完成 | route parity 有證據；runtime/readiness/persistence 仍待驗 |
| `generateContent` 集中 | AI boundary 完成 | 尚需 schema、timeout、cancellation、paid scope |
| `pnpm verify` 綠 | CI quality gate 完成 | script 尚未含 lint/typecheck/coverage/build |
| raw fetch 只出現在 Automation | 可忽略 | 帳務 API 必須走 `apiFetch`，401 行為才一致 |
