# Subscription Billing：Luna 決策完備執行套件

更新日：2026-07-15

這是 subscription-billing 的 safety-first execution package。它保留完整 Phase 2–6 目標，補上 01A–08 的實作邊界、證據、rollback 與 operator gate；01A、01B、04、05、06、08 保留歷史完成證據，02、03、07 因本輪 re-audit 發現缺口而重開，99 completion audit 維持 in_progress。

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

- 本輪從 `main` 的 `957f5f75ce9a3447e97aa2f9a2fe8a95ced5079f` 開始；目前 restore queue、OAuth response validation、Compose origin wiring 與文件修正尚未形成新的已驗證 SHA。
- Codebase MCP `list_projects` 在本輪以 `Transport closed` 失敗；沒有初始化 index，後續以窄範圍 `rg`／direct read 作 documented fallback。
- 01A–06 的 durable mutation、failure-atomic backup/restore、trust/domain/AI boundary、frontend DOM state、strict type/lint、coverage/verify/bundle/CI 已有本地與 CI 證據。
- Batch 07 的 Node 22/24 verify 與 authenticated Docker smoke 已通過：non-root UID、ready health、dummy-auth member/payment/backup、`/data` 隔離與 volume recreation persistence 均有 runner log 證據。
- lint zero、strict compiler flags、coverage floor 與 unified `pnpm verify` 已完成；Batch 08 的 installed LaunchAgent cutover 與 temp authenticated browser smoke 已完成。
- installed LaunchAgent 現在執行 node + tsx + `server.ts`，`active=1`、health readiness ready、DATA_DIR 已驗證；舊 `server.cjs` 歷史錯誤沒有新增。付費 Gemini live proof 仍明確維持 mock-only。
- Batch 08 的 redacted operator capture：[evidence/2026-07-14-batch08-operator.md](./evidence/2026-07-14-batch08-operator.md)。本輪 fresh review 發現的 restore queue、Compose `PUBLIC_ORIGIN`、OAuth response validation 與 LICENSE 缺口已修正；fresh review 現已 P0/P1/P2 全零，99 僅等待新的 exact CI SHA。

## 安全邊界

規劃包建立階段只新增 `docs/luna-plan/**`；後續已授權的 batch execution 變更均記錄在 master plan 與 git history。正式 DB/WAL/SHM、backups、`.env`、installed plist、secrets、production volume 與 paid Gemini 仍不在自動執行範圍。

所有測試用 temp DATA_DIR、dynamic port、fake/dummy credentials。Batch 08 的 plist backup/cutover、credential review、service state 與 browser smoke 已於 2026-07-14 取得明確授權並完成；credential rotation/re-scope、paid Gemini 與 production deployment 仍是分開的 operator decision。

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
→ 08 operator runtime closure（verified）
→ 99 completion audit
~~~

不得以較容易的 subset 宣稱完成。完成必須逐項對應 current evidence，並分開記錄 configured、built/loaded、running、live success。

## 外部參考

- [Vitest 4.1.9 migration guide](https://v4.vitest.dev/guide/migration)
- [Vite backend integration and manifest](https://vite.dev/guide/backend-integration.html)
