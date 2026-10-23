# Vercel + Turso 操作指南

資料基準日：2026-10-23。時區：Asia/Taipei。

Vercel 提供網頁與 API。Turso 保存 SQLite 相容資料。
使用者關閉 Mac 後，雲端網址仍可接收請求。
免費方案沒有本專案的可用性保證。

## 目前驗證狀態

- 已完成：本機資料庫、搬資料與標頭測試。
- 已完成：TypeScript、Promise 檢查與 Vite 建置。
- 未驗證：本專案的 Vercel function 建置與執行。
- 未驗證：完整 HTTP 測試與 `turso dev` 測試。
- 未驗證：Docker 容器。`bash -n` 已通過。
- 未驗證：正式網址、Google 登入與雲端資料搬移。

本輪沙箱拒絕監聽本機連接埠。
Vercel CLI 的快取鎖也位於唯讀目錄。
原聊天須先執行本文的本機驗收。
本輪沒有建立雲端資源或讀取正式資料。

## 先準備帳號與區域

1. 登入自己的 Turso 帳號。
2. 確認帳號使用免費方案。
3. 選擇 Tokyo 作為資料庫主要區域。
4. 登入自己的 Vercel 帳號。
5. 確認用途符合 Hobby 方案條件。

Turso 的東京代碼是 `aws-ap-northeast-1`。
官方區域表以 AWS 代碼列示東京。
參考：[Turso 區域公告](https://turso.tech/blog/turso-cloud-new-regions)。

以下指令由本人執行。代理不執行登入或建庫。
本機既有 Turso CLI 是 `v1.0.34`。
我已核對該版本的 `--help`。
該版本支援 `--location`、`--group` 與 `--wait`。

1. 執行 `turso auth login`。
2. 執行下列指令建立東京群組。

```sh
turso group create billing-jp --location aws-ap-northeast-1 --wait
```

如果免費帳號已有其他群組，先停止建庫。
先確認既有群組是否位於東京。
不要為新增群組而自行升級付費方案。
官方文件說明多群組有方案限制。
參考：[群組指令](https://docs.turso.tech/cli/group/create)。

3. 執行下列指令建立資料庫。

```sh
turso db create billing-prod --group billing-jp --wait
turso db show billing-prod --url
```

現行官方文件以群組決定主要區域。
不要使用未核實的三碼區域代碼。
參考：[建立資料庫](https://docs.turso.tech/cli/db/create)。

4. 執行 `turso db tokens create billing-prod`。
5. 將輸出的憑證存入私人密碼管理工具。

該指令會在本人終端顯示憑證。
不要把憑證貼到聊天、截圖或版本庫。
本程式需要讀寫權限。
不要加上 `--read-only`。
參考：[資料庫憑證](https://docs.turso.tech/cli/db/tokens/create)。

## 搬移 Mac 的資料

先停止 Mac 上的帳務服務。
搬移期間不要再新增付款或更改設定。
不一致的來源副本可能漏掉最新資料。

1. 停止既有服務與其他寫入程序。
2. 保存來源資料庫的安全副本。
3. 確認來源副本可以開啟。
4. 在私人終端設定目標環境變數。

```text
TURSO_DATABASE_URL=剛才取得的 libsql:// 網址
TURSO_AUTH_TOKEN=本人保管的讀寫憑證
```

搬資料腳本讀取目前 shell 的環境變數。
腳本不會自動讀取 `.env`。
不要把憑證填入指令參數或文件。

5. 執行來源試讀。

```sh
pnpm migrate:turso --source /安全副本/database.db --dry-run
```

`--dry-run` 只讀來源資料。
試讀不連線、不建立或更改目標資料庫。
試讀會列出資料筆數與 SHA-256 摘要。

6. 核對來源筆數與帳務範圍。
7. 執行正式搬移。

```sh
pnpm migrate:turso --source /安全副本/database.db
```

腳本先套用目標 migrations。
腳本再以一筆交易寫入業務資料。
腳本會在交易內與提交後核對指紋。
指紋不包含登入截止時間與待審提案。
本腳本不搬移舊磁碟備份。

目標已有業務資料時，腳本會拒絕覆寫。
只有確認目標內容後才可使用 `--force`。
覆寫會在同筆交易保存 `migration.safety` 快照。
寫入失敗時，目標資料與安全快照一起回滾。

先完成資料搬移，再開啟 Vercel 網站。
新網站的月份補進也會寫入資料。
若先開啟網站，搬資料腳本可能拒絕覆寫。

## 設定 Vercel 專案

1. 在 Vercel 選擇匯入 Git repository。
2. 選擇這份 repository 的根目錄。
3. 將 Framework Preset 設為 Vite。
4. 將 Build Command 設為 `pnpm run build`。
5. 將 Output Directory 設為 `dist`。
6. 在 Functions 設定選擇 Tokyo (`hnd1`)。

必須在 Project Settings 確認東京區域。
本次主導者的 probe 未套用 `regions`。
不要只依賴 `vercel.json` 的設定值。
部署後也要查看 function 的實際執行區域。
`/api/health` 回應標頭 `x-vercel-id` 應含 `hnd1`。
官方說明設定檔可覆蓋介面設定。
若兩者不一致，先停止正式驗收。
參考：[Vercel 區域設定](https://vercel.com/docs/functions/configuring-functions/region)。

7. 設定下表的 Production 環境變數。

| 名稱 | 值或用途 |
|---|---|
| `NODE_ENV` | `production` |
| `COOKIE_SECURE` | `true` |
| `PUBLIC_ORIGIN` | `https://<project>.vercel.app`，不含路徑 |
| `APP_SESSION_SECRET` | 本人產生的高強度隨機密鑰，至少 32 字元 |
| `GOOGLE_CLIENT_ID` | Google OAuth 用戶端 ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 用戶端密鑰 |
| `GOOGLE_ALLOWED_EMAILS` | 允許的完整信箱，多個以逗號分隔 |
| `CLIENT_IP_HEADER` | `x-forwarded-for` |
| `TURSO_DATABASE_URL` | 目標資料庫的 `libsql://` 網址 |
| `TURSO_AUTH_TOKEN` | 目標資料庫的讀寫憑證 |
| `GOOGLE_GEMINI_API_KEY` | 選用；未設定時不使用 AI 功能 |

不要設定 `MIGRATE_FROM_JSON=1`。
雲端也不需要 `DATA_DIR` 或 `SQLITE_PATH`。
不要把正式資料或憑證放進 `dist`。
靜態檔案只應包含 Vite 的網頁與素材。

Preview 環境應使用獨立測試資料庫。
不要讓任意預覽分支寫入正式帳務。
若不啟用 Preview API，不要填入正式憑證。

8. 在 Google Cloud Console 選擇 OAuth 用戶端。
9. 加入下列授權重新導向 URI。

```text
https://<project>.vercel.app/api/auth/callback
```

10. 確認允許名單帳號可使用 OAuth 應用程式。
11. 部署 Vercel 專案。
12. 開啟固定的 Production 網址。

`https://<project>.vercel.app` 是公開網址。
Hobby 預設的部署保護不涵蓋 Production 網址。
帳務資料只靠 Google 登入與允許名單保護。

13. 以允許的 Google 帳號登入。
14. 核對成員、付款、帳期與備份。

環境變數更改後，重新部署才會套用。
`APP_SESSION_SECRET` 改變會讓舊 cookie 失效。

## 備份與還原

備份內容存於資料庫的 `backups` 表。
備份名稱保留 `database_*.db` 格式。
該名稱代表 JSON 快照，不是磁碟 SQLite 檔。
本機舊備份檔會保留，但不會自動搬移。

每次帳務變更會先保存變更前快照。
保留規則為最近 50 份、每日 30 份與每月 12 份。
三組規則取聯集，實際份數可超過 50 份。
快照名稱固定使用台北時間。

1. 在網頁的備份清單建立手動備份。
2. 開啟備份預覽並核對影響。
3. 確認後執行還原。
4. 核對帳期、付款與事件鏈。

還原會先驗證快照。
還原會在同一交易保存 `restore.safety`。
還原也會記錄 `backup.restored` 事件。
任何步驟失敗時，整筆交易會回滾。
還原不改動 `auth_state` 與 `automation_proposals`。
已登出的裝置不會因還原而重新登入。

刪除備份與 `backup.deleted` 事件共用交易。
資料庫不再使用磁碟 tombstone。
請定期匯出目前帳務 JSON 並保存私人副本。
同庫快照無法防範整個雲端帳號遺失。

## 免費額度與執行限制

下列是 2026-10-23 的官方資料。
使用者應以帳號當下顯示的方案為準。
兩個方案的月費均為零美元。
本文沒有使用匯率換算。

| 平台 | 免費額度 |
|---|---|
| Turso Free | 100 個資料庫、5 GB 儲存、每月讀取 5 億列、寫入 1,000 萬列 |
| Vercel Hobby | 每月 100 GB 傳輸、100 萬次 function 呼叫、4 CPU 小時、360 GB 記憶體小時 |

Turso 的快照也會占用資料庫儲存空間。
本程式每次讀取會載入全部業務資料。
完整快照與讀回核對也會消耗讀寫額度。
參考：[Turso 價格表](https://turso.tech/pricing)。

Vercel Hobby 限非商業個人用途。
超過免費額度時，功能可能暫停到重置。
本專案將單次 API 最長時間設為 60 秒。
參考：[Vercel Hobby](https://vercel.com/docs/plans/hobby)。

API 不需要一直保持 Mac 程序運作。
API 會在每個 instance 首次請求初始化。
初始化含 migration、資料檢查與月份補進。
久未使用後，首次請求可能較慢。
月份補進由請求觸發，沒有每月背景排程。

限流計數與 RAG 向量索引保留於各 instance 記憶體。
instance 重建後，記憶體資料會消失。
多個 instance 的限流計數不會加總。
索引也不會收到其他 instance 的即時失效通知。
帳務、提案與登入截止時間都保存於 Turso。

Turso 官方記載互動交易有 5 秒逾時。
API 交易只做短暫計算與資料庫操作。
AI 呼叫必須在交易外執行。
大量搬移仍需以實際資料量驗收。
參考：[互動交易](https://docs.turso.tech/sdk/ts/reference#interactive-transactions)。

本機 `file:` 模式只支援單一 Node 程序。
同一檔案的 runtime 共用連線與操作佇列。
不要讓 LaunchAgent 與 Docker 共寫同一檔案。
遠端模式使用資料庫交易協調不同 instance。
本機佇列不能代替遠端並行驗證。

## 本機驗收指令

只使用假資料與未連結的測試 checkout。
下列測試不得指向正式資料庫。

1. 執行 `pnpm run verify`。
2. 在未連結的 checkout 執行下列指令。

```sh
pnpm build:vercel:offline
```

建置腳本會建立假的 `.vercel/project.json`。
建置腳本不會覆寫真實專案連結。
`.vercel` 已加入 `.gitignore`。
本機須已安裝 CLI 與所需 builder。
若 CLI 要求登入，停止並由本人處理。
參考：[Vercel 本機建置](https://vercel.com/docs/cli/build)。

建置後，腳本會檢查公開靜態目錄。
靜態目錄不可包含後端、SQL 或資料庫。
smoke 在第 5 步執行。
smoke 會照部署規則，在 repo 外組出 function。
組出的 function 沒有 libsql 原生檔，和 Vercel 一樣。
smoke 使用假 OAuth、可拋棄的 turso dev 與隨機連接埠。
smoke 會測試 cookie、讀取、付款與備份。

3. 建立一個空的暫存目錄。
4. 在另一個終端啟動測試資料庫。

```sh
turso dev --db-file /暫存目錄/remote-test.db --port 8080
```

`--db-file` 與 `--port` 已在 v1.0.34 核對。
參考：[Turso 本機開發](https://docs.turso.tech/local-development)。

5. 在專案目錄執行完整遠端測試。

```sh
TEST_LIBSQL_URL=http://127.0.0.1:8080 pnpm smoke:vercel
TEST_LIBSQL_URL=http://127.0.0.1:8080 pnpm test:libsql
```

測試會清空該資料庫的 schema。
首次使用時，資料庫必須完全空白。
測試會建立專用標記，以供後續重跑。
已有資料且沒有標記時，測試會拒絕執行。
入口只接受無憑證的 loopback HTTP 網址。
測試檔會依序執行，且每項測試前清空資料。
遠端測試使用真正的獨立 libSQL client。
`file:` 專用的驅動測試會跳過。

6. 測試結束後，按 Ctrl-C 停止 `turso dev`。
7. 刪除本次假資料的暫存目錄。

## 常見問題

### API 回傳網頁或 404

先查看瀏覽器 Network 的 `/api/data`。
未登入應回 401 JSON，登入後應回 200 JSON。
再查 Vercel 的 function request logs。
確認 Express 收到原始 `/api/...` 路徑。
不要把正式付款資料加入除錯 log。

主導者的部署 probe 曾保留原始 `req.url`。
該 probe 的代理也會覆寫 `x-forwarded-for`。
本專案仍須在實際部署後重新確認。
本機 smoke 不會驗證 Vercel 平台 rewrite。

### Google 回報 redirect_uri_mismatch

確認 `PUBLIC_ORIGIN` 是 Production 固定網址。
確認 Google Console 的 URI 完全相同。
callback 路徑必須是 `/api/auth/callback`。
不要混用 Preview 網址與 Production 網址。

### health 回傳 503

先確認 Turso 網址與讀寫憑證。
再查看本人可見的 Vercel function logs。
登入後才會看到詳細 health 資訊。
初始化失敗後，下一個請求可以重試。
不要把含客戶資料的 logs 貼到公開 issue。

### 儲存設定回傳 409

先重新整理頁面，再確認最新設定。
另一個裝置可能已更改相同資料。
提案也可能已被另一個裝置確認或拒絕。
不要自動覆寫新資料。

### 本機測試回報 EPERM

先確認錯誤是監聽連接埠或快取寫入。
不要變更防火牆、全域權限或 sandbox 設定。
將完整指令交給原聊天在允許環境執行。
未跑完的測試必須保持「未驗證」。
