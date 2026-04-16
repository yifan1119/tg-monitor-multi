# Changelog

所有版本的變更記錄。遵循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/) 與 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

<!-- 版本紀律: 每次發版必須在此加一行. 違反 R6 兼容契約 (見 ARCHITECTURE.md) -->

## [0.2.0-mvp] — 2026-04-16

### 新增
- 空模板骨架 (`shared/` + `depts/_template/` + `web/` + `scripts/`)
- Web 後台 (Express + EJS + 霓虹科技風, port 5003)
- **首次設置精靈** (`/setup`): 管理員 / TG API / Google SA 上傳 / 第一個部門
- **Dashboard** (`/dashboard`): 部門狀態燈 + PM2 進程表 + 24h 命中統計 + 空狀態引導
- **部門管理**:
  - `/depts` 列表 + 新增按鈕
  - `/depts/new` 表單 + POST 建目錄 + 重生 ecosystem
  - `/depts/:name/edit` 編輯 config + 自動重啟
  - `/depts/:name/login` TG 登入 wizard (gram.js verify-code 完整流程)
  - POST `/depts/:name/{restart,start,stop,delete}` PM2 控制
- **CLI 工具**:
  - `scripts/new-dept.js` (+ thin wrapper `.sh`) 命令行建部門
  - `scripts/generate-ecosystem.js` 自動生成 PM2 配置
  - `scripts/login-dept.js` 命令行 TG 登入 (從 baseline 搬)
- **升級 / 回滾 / 備份機制**:
  - `scripts/update.sh` git pull + 自動備份 + npm ci + PM2 reload
  - `scripts/rollback.sh` 完整回滾 (含預備份, 防回滾也出錯)
  - `scripts/list-backups.sh` 列出所有備份
  - `scripts/clean-backups.sh` 清理舊備份 (預設保留 5 個)
- **一鍵安裝**: `install.sh` (裝 Node + PM2 + clone + 依賴)
- Google SA 檔案上傳 (multer, 驗證 JSON 結構)
- 表單錯誤 UX: 留在原頁 + 紅色提示 + 保留已填值
- `configVersion: 1` 欄位 (為未來 schema migration 預留)

### 架構
- 從 baseline `yifan1119/tg-monitor-node@41ac92b` 抽出 5 個核心腳本
- 代碼去重: 27 份 copy-paste → 1 份 `shared/`
- 每部門只保留差異 (`depts/<name>/` = config.json + .env + session.txt + state/)
- PM2 用 cwd 區隔各部門執行環境 (代碼不變)

### 相依
- Node.js >= 22
- PM2 >= 6
- 依賴: telegram (gram.js) 2.26.22 / googleapis 171 / express 4 / ejs 3 / multer 2

### 不做 (留後續版本)
- RBAC 多用戶 (當前單一密碼)
- 告警 / heartbeat / 實時日誌流
- Docker 版的未回覆預警 / 刪消息檢測 / 每日日報
- bcrypt 密碼加密 (當前明文存)
- 安全強化: CSRF / rate limit / HTTPS 整合
- 9 部門實機遷移 (另獨立 PR)

---

## [0.1-baseline] — 2026-04-16

baseline 凍結在 [yifan1119/tg-monitor-node](https://github.com/yifan1119/tg-monitor-node)，
作為本專案的歷史起點。不再更新。
