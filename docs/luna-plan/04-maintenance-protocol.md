# Luna 規劃套件維護協議

## 狀態格式

每個 batch 只保留一個主狀態，寫在 `01-master-plan.md` 的 Batch map 與 Evidence ledger。這套件不建立互相競爭的 per-prompt ledger；prompt 只提供欄位與證據契約：

```text
batch:
status:
started_at:
baseline_sha:
write_set:
forbidden_set:
targeted_checks:
full_gate:
runtime_scope:
evidence:
failure_log:
rollback:
next:
```

`verified_complete` 只在所有要求的 evidence 都存在時使用；「沒有找到錯誤」不是完成證據。

## 每個 batch 的固定維護循環

1. 讀 `00`、`01` 與該 prompt。
2. 對 live repo 做 read-only baseline。
3. 只修改 exact write set。
4. 每個獨立檔案寫入後立即 read-back；先保存所有 product/prompt write-set preimages，包含 untracked files；master ledger status/evidence 是 append-only。
5. 先 targeted check，再 full gate。
6. diff/read-back；補上 command output、path:line、runtime scope。
7. 新 finding 若改變 dependency、write set、rollback 或 completion gate，先更新 master plan，再繼續。

## Failure log

```markdown
### YYYY-MM-DD HH:MM batch-XX attempt-N
- hypothesis:
- command:
- observed:
- impact:
- rollback: <product/prompt preimage path and result; non-ledger audit hunk only when applicable>
- next falsifiable hypothesis:
```

禁止寫「模型太笨」或沒有 command/evidence 的主觀結論。

## Fresh finding 回寫規則

- P0：資料遺失、secret leak、未授權 production write、auth bypass。立即停止、保留證據、rollback。
- P1：route contract、restore atomicity、startup readiness、active-month invariant、CI gate 破壞。不能進下一 batch。
- P2：文件漂移、測試缺口、可觀測性不足。修正，或在 master plan 具體列出接受理由與後續 proof。

若新 finding 跨 batch，不能偷偷擴當前 write set；把它變成前置 gate 或新的明確 batch entry。

## Evidence freshness

Evidence 必須說明：

- exact SHA 或 dirty baseline；
- 查證日期與命令；
- temp DATA_DIR / dynamic port / fake credential；
- 是否只 static/configured、是否 built/loaded、是否 running、是否 live success；
- 未驗項目的原因與下一步。

舊 log、舊 rollout、template、manifest、registered MCP 都不能升級成 current live proof。

## Rollback protocol

每批前保存自己的 product/prompt write-set preimages 與 sha256；master ledger status/evidence 不恢復；失敗時：

1. 停止新 write；
2. 先保留 failure log、test output、redacted runtime capture；
3. 從 /tmp/luna-rollback/<batch>-<timestamp>/ 恢復 preimage，不依賴 git diff；
4. read-back hashes、rerun nearest gate；
5. 更新 batch status；
6. 將未解問題交給使用者指定 reviewer 或下一次明確授權。

不使用 destructive git commands。

## Reviewer protocol

每個高風險或長期決策在 final audit 前使用 `fork_turns="none"` 的 fresh reviewer。Reviewer 只讀實際規劃檔與 live repo，回報：

```text
severity | file | finding | evidence | required action
```

作者不得自己把未驗證 finding 標成已解。
