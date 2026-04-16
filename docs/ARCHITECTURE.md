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

### 頁面清單

| 路徑 | 頁面 | MVP 實現 |
|------|------|---------|
| `/` | 首頁（自動轉 /setup 或 /dashboard） | ✅ D4 |
| `/login` | 登入 | ✅ D3（Basic Auth） |
| `/setup` | 首次設置 wizard | ✅ D3 |
| `/dashboard` | 總覽（部門狀態 + PM2） | ✅ D4 |
| `/depts` | 部門列表 + 新增按鈕 | ✅ D5 |
| `/depts/:name/edit` | 編輯 config.json | ✅ D5 |
| `/depts/:name/login` | TG 登入 wizard | ❌ 留 v0.3 |
| `/logs/:name` | 即時 pm2 logs | ❌ 留 v0.3 |
| `/settings` | 系統設置 / 用戶管理 | ❌ 留 v0.3 |
| `/health` | 健康檢查 API | ✅ D1 |

## 認證策略（MVP 簡化版）

- **v0.2 MVP**：單一密碼（Basic Auth），密碼存 `data/system.json` (bcrypt hash)
- **v0.3+**：完整 RBAC（搬 Docker 版 users.json），管理員 / 普通用戶

## 安全邊界

⚠️ MVP **不包含**安全強化（CSRF / rate limit / HTTPS）。部署建議：
- port 5003 **不對公網開放**（防火牆關）
- 透過 SSH tunnel 或 Cloudflare Tunnel 訪問
- v0.9 才做正式的安全加固
