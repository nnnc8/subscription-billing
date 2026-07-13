# Subscription Billing：Luna 決策完備執行套件

更新日：2026-07-13

這是 subscription-billing 的 safety-first execution package。它保留完整 Phase 2–6 目標，補上 01A–08 的實作邊界、證據、rollback 與 operator gate；目前 01A–07 已依證據完成，08 仍需 operator 授權。

## 先讀

1. [00-current-state-audit.md](./00-current-state-audit.md)：live baseline、已完成與未知。
   - [evidence/2026-07-13-baseline.md](./evidence/2026-07-13-baseline.md)：本次 redacted read-only capture。
2. [01-master-plan.md](./01-master-plan.md)：唯一 canonical batch map、介面、不變條件、完成 gate。
3. [02-luna-runbook.md](./02-luna-runbook.md)：第一分鐘、Codebase MCP、Luna CLI、retry 與 handoff。
4. [03-decision-rubric.md](./03-decision-rubric.md)：自行修、停下、rollback、換路、升級。
5. [04-maintenance-protocol.md](./04-maintenance-protocol.md)：狀態與 failure log。
6. [05-handoff-to-luna.md](./05-handoff-to-luna.md)：dirty ownership、禁區、首批入口。

首個 execution prompt 固定是：

~~~text
prompts/01a-durable-save-and-mutation-queue.md
~~~

## 目前的真相

- `main` clean，最新 ledger commit 是 `9e20972`；origin/main 一致。
- Codebase MCP `list_projects` 在本輪以 `Transport closed` 失敗；沒有初始化 index，後續以窄範圍 `rg`／direct read 作 documented fallback。
- 01A–06 的 durable mutation、failure-atomic backup/restore、trust/domain/AI boundary、frontend DOM state、strict type/lint、coverage/verify/bundle/CI 已有本地與 CI 證據。
- Batch 07 的 Node 22/24 verify 與 authenticated Docker smoke 已通過：non-root UID、ready health、dummy-auth member/payment/backup、`/data` 隔離與 volume recreation persistence 均有 runner log 證據。
- lint zero、strict compiler flags、coverage floor 與 unified `pnpm verify` 已完成；browser smoke、LaunchAgent cutover 與 paid Gemini live proof 尚未完成。
- installed LaunchAgent 仍指向已刪除的 `server.cjs` 並 crash-loop；不能把 template 指向 `server.ts` 當成 runtime 已修好。

## 安全邊界

規劃包建立階段只新增 `docs/luna-plan/**`；後續已授權的 batch execution 變更均記錄在 master plan 與 git history。正式 DB/WAL/SHM、backups、`.env`、installed plist、secrets、production volume 與 paid Gemini 仍不在自動執行範圍。

所有測試用 temp DATA_DIR、dynamic port、fake/dummy credentials。Batch 08 的 credential review/rotation、plist backup/cutover、service state、browser smoke 與 production deployment 需要使用者另行明確授權。

## Batch 順序

~~~text
01A durable save / queue
→ 01B route cutover / export / readiness
→ 02 backup / restore / migration
→ 03 trust / domain / AI
→ 04 frontend state / DOM
→ 05 strict type / lint
→ 06 coverage / verify / bundle / CI
→ 07 Docker / README
→ 08 operator-only runtime closure
→ 99 completion audit
~~~

不得以較容易的 subset 宣稱完成。完成必須逐項對應 current evidence，並分開記錄 configured、built/loaded、running、live success。

## 外部參考

- [Vitest 4.1.9 migration guide](https://v4.vitest.dev/guide/migration)
- [Vite backend integration and manifest](https://vite.dev/guide/backend-integration.html)
