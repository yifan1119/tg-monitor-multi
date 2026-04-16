# Architecture

## 設計原則

1. **苏总原本架構已跑通** — 5 類進程 / PM2 管 / 純 JSON 狀態 / gram.js / Google Sheet，這些不動
2. **代碼已經通用** — baseline 9 部門代碼 MD5 全同，差異全靠 config.json，不需要改業務邏輯
3. **模板化是打包，不是重構** — MVP 把 9 份散落代碼收成 1 份 shared/，加一層 Web 包裝

## 運行時拓撲（單部門視角）

```
TG 業務群 × N (每部門加入的客戶群)
        │ gram.js MTProto 訂閱
        ↓
  shared/listener.js (PM2: tg-listener-<dept>)
        │ 命中關鍵字 → 格式化推送
        ↓
  「中轉群」(outputChatName) ←──┐
        │                      │
        ↓                      │
  shared/sheet_writer.js       │
  (PM2: tg-sheet-writer-<dept>)│
        │                      │
        ↓                      │
  Google Sheet (每部門一本)     │
                               │
  shared/system_events.js ─────┘
  (監聽群系統事件，寫 state/)
```

全局進程（全系統一組，不分部門）：
- `shared/title_sheet_writer.js` — 跨部門群名變更彙總
- `shared/review_report_writer.js` — 定期審查日報

## 目錄職責

```
tg-monitor-multi/
├── shared/        ← 一份代碼 + 一份 node_modules, 所有部門共用
├── depts/         ← 每部門只存「差異」(config + env + session + state)
├── web/           ← Express 管理後台 (讀 PM2 狀態, 改 depts/*/config.json)
├── data/          ← Web 用戶資料 + 系統級設置 (非部門級)
├── scripts/       ← CLI 工具 (新增部門, 登入, 遷移)
└── docs/          ← 本目錄
```

### 為什麼 depts/ 每部門獨立，而不是合併到一個 db

- **故障隔離**：一部門 config 錯不影響其他
- **TG 帳號分離**：每部門一個 session.txt（TG 真人號不能共享）
- **備份顆粒度**：可以單獨備份某部門
- **刪部門乾淨**：`rm -rf depts/<name>` 就結束，不需跨表操作
- **PM2 cwd 設計**：PM2 進程的 cwd 指到 `depts/<name>/`，代碼用相對路徑讀 config，天然做好隔離

### 為什麼 google-service-account.json 放 shared/

- 同一把 Google Service Account key 能訪問所有 Sheets（只要 SA email 加入各 Sheet 的共享權限）
- 省得每部門複製一份（baseline 現在複製 11 份）
- 單一管理點，輪換也方便

## 新增部門的數據流

```
1. scripts/new-dept.sh <name>
   └─ 從 depts/_template/ 複製到 depts/<name>/
   └─ 重命名 config.json.example → config.json
   └─ 建立 state/ 目錄

2. 使用者編輯 depts/<name>/config.json 填入實際值
   └─ outputChatName (中轉群名)
   └─ spreadsheetId (Google Sheet ID)
   └─ sheetName (分頁名)

3. 使用者編輯 depts/<name>/.env
   └─ TG_API_ID / TG_API_HASH

4. node scripts/login-dept.js (在 depts/<name>/ 底下跑)
   └─ 交互式: 手機號 → 驗證碼 → 2FA
   └─ 寫入 depts/<name>/session.txt

5. 啟動: pm2 start ecosystem.config.js --only tg-*-<name>
   └─ ecosystem 會自動掃 depts/ 生成每部門 3 類進程
```

## PM2 進程命名規則

```
tg-listener-<dept>        ← 每部門
tg-system-events-<dept>   ← 每部門
tg-sheet-writer-<dept>    ← 每部門
tg-title-sheet-writer     ← 全局單例
tg-review-report-writer   ← 全局單例
```

每部門 3 個進程 + 2 個全局 = N × 3 + 2 總進程數。

## Web 管理後台（v0.2 MVP 設計）

port 5003（避開 Docker 版 5001 和其他可能占用）

### 頁面清單 (v0.2.0-mvp)

| 路徑 | 頁面 | 狀態 |
|------|------|-----|
| `/` | 自動轉 /setup 或 /dashboard | ✅ |
| `/login` | 登入 | ✅ (無驗證, v0.3 加 bcrypt) |
| `/setup` | 首次設置 wizard (含 Google SA 上傳) | ✅ |
| `/dashboard` | 總覽 (部門狀態 + PM2 + 空狀態引導) | ✅ |
| `/depts` | 部門列表 + 新增按鈕 | ✅ |
| `/depts/new` | 新增部門表單 | ✅ |
| `/depts/:name/edit` | 編輯 config.json + PM2 控制 | ✅ |
| `/depts/:name/login` | TG 登入 wizard (4 步) | ✅ |
| `/depts/:name/{restart,stop,start,delete}` | POST 控制 | ✅ |
| `/logs` `/logs/:name` | 即時 pm2 logs | ❌ 留 v0.3 |
| `/settings` | 系統設置 / 用戶管理 | ❌ 留 v0.3 |
| `/health` | 健康檢查 API (JSON) | ✅ |

## 認證策略

- **v0.2 MVP**: 單一密碼 (data/system.json 明文 — 僅內網部署可接受)
- **v0.3+**: bcrypt hash + 多用戶 RBAC (借 Docker 版 users.json)

## 安全邊界

⚠️ MVP **不包含**安全強化 (CSRF / rate limit / HTTPS). 部署要求:
- port 5003 **不對公網開放** (防火牆擋)
- 公網訪問用 Cloudflare Tunnel / SSH tunnel / Caddy + HTTPS
- v0.9 才做正式的安全加固

---

## 向後兼容契約 (R1–R7)

**每次發版必須遵守.** 違反任一條 = 會打破已部署客戶的升級路徑.

### R1 — Schema 只加不改
`config.json` 欄位: **只加新欄位, 不改既有欄位的名稱或含義**.
- 加欄位時代碼要提供預設值 (可選, 舊版 config 讀得進來)
- 若真要改既有欄位 → 走 **migration** (`configVersion` 遞增 + migrate 腳本)

### R2 — `.env` 只加 key 不刪
新版可新增 env 變數, **不能刪舊變數**.
- 舊 key 若不再使用, 可用 deprecation 註解但不真刪 (至少跨一個 minor 版本後才清)

### R3 — 用戶資料升級絕不動
`update.sh` / `rollback.sh` 對以下檔案 **永遠唯讀**:
- `depts/*/session.txt` (TG 登入憑證)
- `depts/*/.env` (TG API 憑證)
- `depts/*/state/*` (event_history / pending_*)
- `shared/google-service-account.json` (Google 憑證)
- `data/system.json` (系統狀態)

這些檔案在 `.gitignore`, git 永遠不會覆寫.

### R4 — 新功能預設關閉
引入新功能時, `.env` 加開關, **預設 false**.
- 避免升級即啟用副作用
- 用戶有意識地打開才生效

### R5 — 跨版本跳升要能過
v0.2.0 → v0.5.0 一步到位要能升. 不能要求 "必須先升到 v0.3 再升 v0.5".
- migrate 腳本必須能串聯執行 (v1 → v2 → v3 → ...)

### R6 — 每版 tag + CHANGELOG
- 每次發 release 必須 `git tag vX.Y.Z`
- `CHANGELOG.md` 必須加一段
- `VERSION` 必須更新
- 三者缺一視為未發版

### R7 — 客戶第一個月只升 patch
客戶首次部署後 **第一個月內**, 維護者只 push patch (vX.Y.Z 的 Z 遞增).
- 禁止 minor / major 升級
- 給客戶穩定 baseline 的時間
- 遇到 bug 才出 patch

---

## 升級 / 回滾 機制

### 備份策略
- 每次 `update.sh` 自動把 `depts/` + `data/` 快照到 `.backups/<timestamp>/`
- 快照含 `commit` (舊 HEAD) + `version` (舊 VERSION) + `timestamp`
- `.backups/` 在 `.gitignore`, 不入 repo
- `clean-backups.sh` 預設保留最近 5 個

### 回滾保命
- `rollback.sh` 執行前 **再備份一次當前狀態** 到 `.backups/rollback-safety-<timestamp>/`
- 意味著: 回滾也能回滾
- 即使連 3 次回滾都選錯, 每一步的狀態都在

### 原子性
- `git pull --ff-only`: 不接受 merge commit, 升級永遠是線性
- `npm ci`: 按 `package-lock.json` 裝確切版本, 不會抓到新版依賴污染
- 失敗即退出 (`set -euo pipefail`), 不留半升級狀態

### 升級流程
```
update.sh
├── 1. 記錄 OLD_COMMIT, OLD_VERSION
├── 2. cp -r depts/ data/ → .backups/<ts>/
├── 3. git pull --ff-only
├── 4. npm ci (shared/ + web/)
├── 5. node scripts/generate-ecosystem.js
└── 6. pm2 reload ecosystem.config.js
```

### 回滾流程
```
rollback.sh <backup_dir>
├── 1. 再備份當前 depts/ + data/ → .backups/rollback-safety-<ts>/
├── 2. git reset --hard <old_commit>
├── 3. npm ci (shared/ + web/)  [按舊 package-lock.json]
├── 4. 還原 depts/ 和 data/
├── 5. node scripts/generate-ecosystem.js
└── 6. pm2 reload ecosystem.config.js
```
