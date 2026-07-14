# Historical rollback reconstruction — 2026-07-14

This is an evidence-preserving historical reconstruction, not an original pre-edit capture. It is recorded so the 99 reviewer can decide whether the two historical rollback gaps are resolved without promoting a later snapshot to an original preimage.

## Source and method

- Audit source: `/Users/nc8/.codex/sessions/2026/07/13/rollout-2026-07-13T18-40-33-019f5b10-76eb-73f2-932e-ddbac8a9f315.jsonl`.
- The session's call ledger shows 01B product patches at calls `179, 181, 182, 183, 184, 185, 187, 188, 189, 190, 194, 196, 198, 203`; call `172` was documentation-only and call `209` captured the post-01B snapshot.
- The late snapshot was copied to `/tmp/luna-rollback/01b-late-20260713-215400/`; each listed 01B patch was reverse-applied in exact reverse order in an isolated copy.
- The resulting files were materialized at `/tmp/luna-rollback/01b-reconstructed-20260714-154920/` with the hashes below.

## 01B reconstructed preimage

```text
server/app.ts                         b1de98302c95d0c77866a9010992776759bdabe5e9a1a438515b500d0aa71a44
server/routes/ai-automation.ts       87619515df3cb1f588726906131ac50de9437cfa30fc625355d9882a285adb83
server/routes/auth-runtime.ts        61b597ba9cc436fe462dfd45f1c4cccc2b2dab498b7d915712965fd28a327bde
server/routes/data.ts                23d9a52029d2bf22a664b17057f1e12e48e73d53397aeba09b50ef516a90371d
server/routes/lifecycle-audit.ts     2c41dfa7f0a48907318cf6b74728d7383bee677bedbd97198870cb3979d69846
server/routes/settings-entities.ts   6ce4091a4fd41970ac5b9cc3844368688a46d3a71de599bf47af5e88f6a47a0b
server/routes/shared.ts               6bad82f2fc691e7372fb85d8303a48d7e56f136ec8a7d91aea62ca0d1e0b62ef
server/runtime.ts                     935bae87d7ba1ef7166a8ffc39403a6f169b9e21f40d576e6f46c1589d5add1e
tests/mutation-queue.test.ts          0143637fd8391d8fd0622900bfad2253a0eb71d42d9a284fffcfcaebb8a55538
tests/server.integration.test.ts     4ca6875f79a3338029e1ff82990cb25058b01887a67d5f4e57e7938b7a889d2b
```

Independent cross-check: `server/runtime.ts`, `server/routes/shared.ts` and `tests/mutation-queue.test.ts` exactly match the state obtained by forward-applying the recorded 01A patches to the 01A preimage at `/tmp/luna-rollback/01a-20260713-213003/`. The three matching SHA-256 values are `935bae87d7ba1ef7166a8ffc39403a6f169b9e21f40d576e6f46c1589d5add1e`, `6bad82f2fc691e7372fb85d8303a48d7e56f136ec8a7d91aea62ca0d1e0b62ef` and `0143637fd8391d8fd0622900bfad2253a0eb71d42d9a284fffcfcaebb8a55538`.

## 02 `server.ts` reconstructed preimage

- Source post-edit snapshot: `/tmp/luna-rollback/02-late-20260713-220520/server.ts`.
- Exact reverse operation: session call `227`, changing `await runtime.initializeAtomic()` back to `runtime.initialize()`.
- Materialized preimage: `/tmp/luna-rollback/02-reconstructed-20260714-154920/server.ts`.
- SHA-256 post-edit: `7b06a06d10d28a607ca73b5cf76b625d342ec5b155e14e9a40167e2fc13687aa`.
- SHA-256 reconstructed preimage: `74310d9172dd69836f8ca34df837046b05c0e32985ef6676426769ebbe1e9dc3`.

The reconstructed preimage intentionally does not use `git show 6028913:server.ts`: the baseline worktree was dirty and the commit-tree hash is `81ce09ea19e4ec17e229e275cc038ddebcd1b0b214d20d766f343b9816b5c193`, so the commit is not the correct historical pre-02 file.

## Disposition

No product, dependency, service, database, secret or git-index file was changed by this reconstruction. These artifacts are sufficient for an evidence-preserving rollback review, but the original pre-edit capture was not made at execution time. 99 remains `pending` until a fresh reviewer explicitly classifies whether this reconstruction satisfies the plan's P1 rule.

The subsequent read-only recovery search found no reflog/dangling object containing the missing execution-time state. The initial baseline status listed the 01B route/test files as untracked and `server.ts` as already dirty, so neither the baseline commit tree nor a later snapshot can be promoted to an original capture.

## User-authorized disposition — 2026-07-14

The user explicitly granted maximum authority to handle this blocker and continue through commit/push/deployment verification. The canonical plan now accepts this reconstruction only under its six-condition exception and only after a fresh reviewer records P0=0 and P1=0. Fresh reviewer `019f5fb7-6305-70f1-a4a2-85d4715cce6d` recorded PASS with P0=0/P1=0/P2=0. The files remain labeled as reconstructed; no claim of original execution-time capture is made.

Deployment verification commit `00ec047fbc9278b9537489968d859fd63ead95fe` was pushed to `origin/main`; CI run `29318203377` passed Node 22, Node 24 and Docker smoke. Subsequent documentation alignment commits are docs-only. The local LaunchAgent/runtime read-back also remained healthy after the push.
