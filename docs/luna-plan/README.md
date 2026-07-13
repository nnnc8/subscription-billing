# Subscription Billing：Luna 決策完備執行套件

更新日：2026-07-13

這是 subscription-billing 的 safety-first execution package。它保留完整 Phase 2–6 目標，補上 01A–08 的實作邊界、證據、rollback 與 operator gate。

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

- working tree 是 dirty main；本次文件建立前 HEAD 是 6028913dd95e。
- Codebase MCP project Users-nc8-subscription-billing 已 indexed/ready。
- backend route split、SQLite repositories、四導航與 Gemini transport 的靜態部分已存在。
- 現有 11 個 test files / 94 tests 與 legacy pnpm verify 綠。
- lint 有 5 warnings；strict compiler flags、coverage、unified verify、CI/Docker/browser/LaunchAgent live proof 未完成。
- installed LaunchAgent 仍指向已刪除的 server.cjs；不能把 template 指向 server.ts 當成 runtime 已修好。

## 安全邊界

本次文件交付只新增 docs/luna-plan/**。不得修改產品、依賴、服務、git index、正式 DB/WAL/SHM、backups、.env、installed plist 或 secrets。

未來 prompt 的產品 write set 只在另一次明確授權後執行。所有測試用 temp DATA_DIR、dynamic port、fake/dummy credentials；paid Gemini、production volume、credential rotation、commit/push 與 deployment 都是獨立授權事項。

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
