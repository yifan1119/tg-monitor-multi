# tg-monitor-multi

**多部門 Telegram 業務群監控系統模板**

一台 VPS 可承載 N 個部門，每部門獨立 TG 真人號監聽業務群，命中關鍵字（到期 / 下架 / 打款 / 欠費...）自動轉發到中轉群 + 寫 Google Sheet 存檔。

對齊姊妹專案 [`tg-monitor-template`](https://github.com/yifan1119/tg-monitor-template)（外事號**私聊**監控）——本 repo 聚焦**業務群**監控，多部門共享 VPS。

---

## 快速開始（Docker 主推）

### 一鍵裝

```bash
curl -fsSL https://raw.githubusercontent.com/yifan1119/tg-monitor-multi/main/install.sh | bash
```

做完這些：裝 Docker → clone → build image → `docker compose up -d`。

預設裝到 `/opt/tg-monitor-multi`。想換路徑：`INSTALL_DIR=~/tg-mm WEB_PORT=5003 bash install.sh`

### Setup 嚮導

開瀏覽器 → `http://<vps-ip>:5003/setup` → 走 4 節：

1. Web 後台管理員帳密
2. TG API ID/Hash（從 <https://my.telegram.org/apps> 取得）
3. 上傳 Google Service Account JSON
4. 第一個部門（代號 / 中轉群名 / Sheet ID / 分頁名）

完成後自動建立 `depts/<第一個部門>/` 目錄。

### TG 登入 + 啟動

Dashboard → 點部門卡 → 「🔑 去登入 TG」 → 手機號 → 驗證碼 → （若有）2FA → `session.txt` 自動寫入。

然後點「▶ 啟動」，PM2 在容器內啟動 3 個進程：
- `tg-listener-<name>` — 監聽所有業務群
- `tg-system-events-<name>` — 監聽群系統事件
- `tg-sheet-writer-<name>` — 寫 Google Sheet

### 裸跑模式（進階）

不想用 Docker 的可走 `install-bare.sh`（見 [docs/DEPLOY-BARE.md](docs/DEPLOY-BARE.md)）。

完整部署文件：
- Docker 模式：[docs/DEPLOY-DOCKER.md](docs/DEPLOY-DOCKER.md)
- 裸跑模式：[docs/DEPLOY-BARE.md](docs/DEPLOY-BARE.md)

---

## 架構簡圖

```
┌─ TG 業務群 (每部門加入 N 個客戶群) ─────────────────┐
│                                                     │
│   以部門的 TG 真人號登入監聽                        │
│   (非 Bot — Bot 在群裡收不到普通訊息)               │
└─────────────────┬───────────────────────────────────┘
                  │
                  ↓
  ┌───────────────────────────────────────────┐
  │ listener (PM2: tg-listener-<dept>)        │
  │ - 命中關鍵字 → 格式化成「提醒」            │
  │ - 同群同關鍵字 10 分鐘冷卻 (防刷屏)         │
  │ - 群名變更也推                             │
  └────────┬──────────────────────────────────┘
           │ client.sendMessage(中轉群, ...)
           ↓
  ┌───────────────────────────────────────────┐
  │ 部門「中轉群」  (例: 悦达-业务审查)         │
  │ 主管在這裡看全部部門動態                    │
  └────┬──────────────────────────────────────┘
       │ 訂閱 (同一 TG 號)
       ↓
  ┌───────────────────────────────────────────┐
  │ sheet-writer (PM2: tg-sheet-writer-<dept>)│
  │ - 解析提醒 → 插入 Google Sheet 第 5 行     │
  │ - 60s backfill 掃最近 30 條                │
  │ - 內容 hash 去重                           │
  └────┬──────────────────────────────────────┘
       │
       ↓
   Google Sheet (每部門一本)
```

每部門配置獨立，互不影響。詳見 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

### 全局進程（可選）

部門進程處理「自己的群」；全局進程處理「跨部門的彙總」，對齊 baseline 架構：

| 全局進程 | 用途 | 需要 |
|---------|------|------|
| `tg-title-sheet-writer` | 跨部門群名變更彙總（訂閱多個中轉群 → 分流寫各部門 Sheet） | 獨立 TG 號 + config 的 `routes` map |
| `tg-review-report-writer` | 審查報告閉環跟蹤（訂閱多個審查報告群 → 寫總表） | 獨立 TG 號 + config 的 `inputChatNames` 陣列 |

**建立流程**：
```bash
# 1. 建目錄
node scripts/new-global.js title-sheet-writer

# 2. 編輯 config
vi global/title-sheet-writer/config.json    # 填 routes / spreadsheetId

# 3. TG 登入
node scripts/login-global.js title-sheet-writer

# 4. 重生 + 啟動
node scripts/generate-ecosystem.js
pm2 start ecosystem.config.js --only tg-title-sheet-writer
```

Web 後台 `/settings` 頁可看狀態 + 控制重啟/啟停。**編輯 config 和 TG 登入目前仍用 CLI**（config 結構較複雜，Web 表單留 v0.3）。

---

## 日常運維

全部可在 Web 完成（不用 SSH）。

| 操作 | 路徑 |
|------|------|
| 看總覽 | `/dashboard` |
| 部門列表 | `/depts` |
| 新增部門 | `/depts/new` |
| 編輯 config | `/depts/:name/edit` |
| 重啟 / 啟動 / 停止 | 編輯頁的按鈕 |
| TG 登入 / 重新登入 | `/depts/:name/login` |
| 刪除部門 | 編輯頁（會搬到 `.trash-<ts>-<name>/`，不立即刪） |
| 查系統狀態 | `/health` JSON |
| 系統設置 · 全局進程 · 健康檢查 | `/settings` |

### 命令列（進階）

```bash
# 新增部門
node scripts/new-dept.js <name> <display> "<output_chat>" <sheet_id> "<sheet_tab>"

# 重生 PM2 配置
node scripts/generate-ecosystem.js

# 啟動某部門所有進程
pm2 start ecosystem.config.js --only tg-listener-<name>,tg-system-events-<name>,tg-sheet-writer-<name>
```

---

## 健康檢查（可選）

對齊 baseline 架構 — cron 每 5 分鐘掃一次 PM2，非 online 的進程自動 `pm2 restart`。

```bash
# 啟用
bash scripts/install-healthcheck.sh

# 看狀態
bash scripts/install-healthcheck.sh --status

# 停用
bash scripts/install-healthcheck.sh --remove
```

或到 Web `/settings` 頁一鍵啟用/停用。

**⚠️ 故意不護 listener**：baseline 設計決策。listener 重啟會掉 TG session，且通常壞了是 session.txt 失效需人工處理，不該自動 restart。健康檢查只護：
- `tg-system-events-*`
- `tg-sheet-writer-*`
- `tg-title-sheet-writer`
- `tg-review-report-writer`

日誌：`.healthcheck/healthcheck.log`（超過 5MB 自動輪替）。

---

## 升級 & 回滾

### 升級到最新版

```bash
cd /opt/tg-monitor-multi
bash scripts/update.sh
```

做什麼（自動）：
1. 備份 `depts/` + `data/` 到 `.backups/<timestamp>/`
2. `git pull --ff-only`（拒 merge，拒衝突）
3. `npm ci`（依舊 `package-lock.json` 嚴格裝）
4. 重生 `ecosystem.config.js`
5. `pm2 reload`

**升級永遠不動** `session.txt` / `.env` / `google-service-account.json` / `state/` / `data/system.json`（見 [向後兼容契約 R1-R7](docs/ARCHITECTURE.md#向後兼容契約-r1r7)）。

### 回滾

```bash
# 列出可用備份
bash scripts/list-backups.sh

# 回滾到某次備份
bash scripts/rollback.sh .backups/20260416-130000/
```

回滾前會**再備份一次當前狀態**（放 `.backups/rollback-safety-<ts>/`），所以回滾本身也可回滾。

### 清理舊備份

```bash
bash scripts/clean-backups.sh           # 預設保留最近 5 個
bash scripts/clean-backups.sh --keep 10 # 保留 10 個
bash scripts/clean-backups.sh --all     # 全刪
bash scripts/clean-backups.sh --dry-run # 只看不刪
```

---

## 敏感檔案（已 `.gitignore`）

| 檔案 | 作用 | 洩漏後果 |
|------|------|---------|
| `depts/*/session.txt` | TG 登入憑證（StringSession） | ⚠️ **帳號被接管** |
| `depts/*/.env` | TG_API_ID / TG_API_HASH | ⚠️ API 濫用風險 |
| `shared/google-service-account.json` | Google Cloud SA 私鑰 | ⚠️ Google 資源被盜 |
| `data/system.json` | Web 管理員密碼（MVP 明文） | ⚠️ Web 後台被接管 |

**建議**：對 `depts/*/session.txt` 做加密備份（如 `age` / `gpg` + 另存雲端）。這是 9+ 個 TG 真人號的命根子，硬碟壞了就要全部重登。

---

## 安全建議

MVP **不做** HTTPS / CSRF / rate limit。建議：

- **Port 5003 不對公網**（防火牆擋）
- 公網訪問用 **Cloudflare Tunnel** 或 **SSH tunnel**
- 或加 **Caddy** 反代 + 自動 HTTPS
- Setup 後把 `data/system.json` 的權限設 600（`chmod 600 data/system.json`）

正式的安全加固在 v0.9 做（見 ROADMAP）。

---

## 版本 / 兼容性

- 當前：**v0.2.0-mvp** — 初版 MVP，跟 baseline 業務邏輯完全一致
- baseline：[yifan1119/tg-monitor-node](https://github.com/yifan1119/tg-monitor-node) commit `41ac92b`（歷史 snapshot，不再更新）
- 向後兼容契約（R1-R7）：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#向後兼容契約-r1r7)
- 完整版本記錄：[CHANGELOG.md](CHANGELOG.md)

---

## 相關專案

- **Docker 版 tg-monitor-template** — 外事號**私聊**監控（1 客戶 1 VPS）  
  https://github.com/yifan1119/tg-monitor-template
- **本 repo tg-monitor-multi** — 業務**群**監控（1 VPS N 部門）

兩者業務場景不同，技術棧也不同，但視覺語言和升級紀律對齊。

---

## 授權

未釋出對外授權（Private repo 使用）。
