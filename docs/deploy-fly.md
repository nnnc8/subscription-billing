# 部署到 Fly.io：手機和電腦都能用 Google 登入

照著做完，你會得到：

- 一個固定的 HTTPS 網址 `https://<你的 app 名稱>.fly.dev`，任何裝置打開都能用。
- 只有 `GOOGLE_ALLOWED_EMAILS` 裡的 Google 帳號能登入。
- 資料放在東京機房（`nrt`）的一顆磁碟（volume）上，有兩層備份：
  - 程式每次寫入都會自動備份：保留最近 50 次，加上最近 30 天每天一份、最近 12 個月每月一份。
  - Fly 每天另外對整顆磁碟拍快照，保留 30 天，存放在機器以外的地方。
- 閒置時機器會自動停機省錢；下次打開網址會自動啟動，第一次載入會多等幾秒。

> **只能跑 1 台機器。** 這個程式用 SQLite，寫入佇列也在程式記憶體裡，所以不要執行 `fly scale count 2`。另外，AI 待審提案目前只存在記憶體裡，機器停機或重新部署後會消失。

---

## 0. 事前準備

1. 安裝 Fly 指令工具（macOS）：

   ```bash
   brew install flyctl
   ```

2. 註冊或登入。Fly 需要綁信用卡，實際費用以 [Fly.io 價目表](https://fly.io/docs/about/pricing/) 為準：

   ```bash
   fly auth signup   # 第一次使用
   fly auth login    # 已經有帳號
   ```

以下指令都在專案根目錄（有 `fly.toml` 的地方）執行。

## 1. 建立 app 和磁碟

```bash
fly apps create <你的 app 名稱>        # 例如 nc8-billing，網址會是 https://nc8-billing.fly.dev
```

接著打開 `fly.toml`，把第一行的 `app = "subscription-billing-change-me"` 改成你剛取的名稱。

```bash
fly volumes create billing_data --region nrt --size 1
```

Fly 可能會提醒「只有一顆 volume 沒有備援」，輸入 `y` 繼續。這個程式本來就只能跑一台，備援由前面說的兩層備份負責。

## 2. 設定 Google 登入

1. 打開 [Google Cloud Console](https://console.cloud.google.com/)，建立或選一個專案。
2. 進入 **Google Auth Platform**（舊版介面叫「OAuth 同意畫面」）：
   - **Branding**：填應用程式名稱和你的 email。
   - **Audience**：使用者類型選「外部（External）」，發布狀態維持「測試中（Testing）」，在 **Test users** 加入你要登入的 Gmail。
3. 進入 **Clients** → **Create client**：
   - 應用程式類型：**網頁應用程式（Web application）**
   - **已授權的重新導向 URI**：`https://<你的 app 名稱>.fly.dev/api/auth/callback`
   - 建立後複製 **Client ID** 和 **Client secret**。

測試模式下登入時，Google 會顯示「這個應用程式未經驗證」，點「繼續」即可。Google 端的設定可能要幾分鐘才會生效。

## 3. 設定密鑰

```bash
fly secrets set \
  APP_SESSION_SECRET="$(openssl rand -base64 48)" \
  GOOGLE_CLIENT_ID="<Client ID>" \
  GOOGLE_CLIENT_SECRET="<Client secret>" \
  GOOGLE_ALLOWED_EMAILS="you@gmail.com" \
  PUBLIC_ORIGIN="https://<你的 app 名稱>.fly.dev"
```

- 要讓多個帳號登入，`GOOGLE_ALLOWED_EMAILS` 用逗號分隔。
- 要用 AI 功能，再加一個 `GOOGLE_GEMINI_API_KEY="<你的金鑰>"`。
- 其他設定（`NODE_ENV`、`DATA_DIR` 等）已寫在 `fly.toml` 裡，不用另外設。

## 4. 部署

```bash
fly deploy
```

完成後用 `fly open` 打開網站，或直接在手機瀏覽器輸入網址，用 Google 登入。有問題時看 `fly status` 和 `fly logs`。

第一次部署的資料庫是空的。要把 Mac 上的資料搬上來，接著做第 5 步。

## 5. 把 Mac 上現有的資料搬上去

1. **先停掉 Mac 上的服務**，之後只用雲端版本，避免兩邊各自記帳：

   ```bash
   pnpm run launchd:uninstall   # 如果是用背景服務跑的；手動跑 pnpm start 的話直接停掉
   ```

2. 在 `database.db` 所在的資料夾（預設是專案根目錄）做一份一致的單檔副本：

   ```bash
   sqlite3 database.db ".backup migrate.db"
   ```

3. 先打開一次網址，確保雲端機器正在執行（停機中的機器無法連線），再上傳副本：

   ```bash
   fly ssh sftp shell
   # 出現提示後輸入：
   put migrate.db /data/import.db
   # 按 Ctrl-D 離開
   ```

4. 換上新資料並重新啟動：

   ```bash
   fly ssh console -C "sh -c 'cd /data && mv database.db empty-before-import.db && rm -f database.db-wal database.db-shm && mv import.db database.db && chown node:node database.db'"
   fly apps restart <你的 app 名稱>
   ```

5. 重新整理網頁，確認成員、付款和帳期都正確。確認沒問題後可以刪掉 `/data/empty-before-import.db`。

## 6. 之後更新程式

```bash
git pull
fly deploy
```

## 7. 備份與還原

- **平常用：**「設定」→「資料備份與還原」→「管理備份」。可以看每份備份和現在的差異，再一鍵還原。
- **異地備份：** 同一個面板有「下載完整資料（JSON）到這台裝置」。建議每月下載一份，存到自己的電腦或雲端硬碟。
- **最後手段（整顆磁碟壞掉時）：** 從 Fly 的每日快照建立新磁碟：

  ```bash
  fly volumes list                                 # 找到 volume ID
  fly volumes snapshots list <volume ID>           # 找到要還原的快照 ID
  fly volumes create billing_data --snapshot-id <快照 ID> --region nrt --size 1
  ```

  之後把機器換到新磁碟上，步驟見 [Fly 快照文件](https://fly.io/docs/volumes/snapshots/)。

## 8. 安全相關

- **手機遺失，或懷疑有人登入：** 從任何一台裝置點左側（手機版在右上角）的「登出所有裝置」，所有裝置都要重新登入。也可以執行 `fly secrets set APP_SESSION_SECRET="$(openssl rand -base64 48)"` 換掉密鑰，效果一樣。
- **移除某個帳號：** 從 `GOOGLE_ALLOWED_EMAILS` 拿掉並重新 `fly secrets set`，該帳號已登入的裝置會立即失效。
- 登入和 AI 功能都有次數限制，被擋時會顯示「請稍後再試」。

## 9. 常見問題

| 狀況 | 原因與處理 |
| --- | --- |
| Google 顯示 `redirect_uri_mismatch` | Google Console 裡的重新導向 URI 必須和 `https://<app>.fly.dev/api/auth/callback` 完全一樣。修改後可能要等幾分鐘。 |
| 登入後顯示 `Google account is not allowed` | 該 Gmail 不在 `GOOGLE_ALLOWED_EMAILS` 裡，或在 Google 的測試模式下沒有加入 Test users。 |
| 顯示 `Invalid OAuth state` | 登入頁開超過 10 分鐘，或在不同瀏覽器完成登入。重新點「使用 Google 登入」即可。 |
| 打開網站很慢 | 機器剛從停機狀態啟動，等幾秒就好。 |
| 網站出現 503 | 用 `fly logs` 看啟動錯誤。登入後打開 `/api/health` 會顯示詳細原因（沒登入時只顯示 ok/blocked）。 |
| 儲存設定時出現「資料已在其他裝置更新」 | 另一台裝置剛改過設定。畫面會自動重新載入；你尚未儲存的修改還在，檢查後再按一次儲存即可。 |
