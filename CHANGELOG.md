# Changelog

所有版本的變更記錄。遵循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/) 與 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

<!-- 版本紀律: 每次發版必須在此加一行. 違反 R6 兼容契約 (見 ARCHITECTURE.md) -->

## [0.3.1-docker] — 2026-04-17

UI 细节改进 + 全局进程 Web 化.

### 改动
- 关键字: textarea (每行一个) → input (逗号分隔), 后端支持 , ， 、 \n\r 四种分隔符
- 时间单位: UI 从 ms 改成分钟/秒 (后端仍用 ms 存 config, 不破坏 R1 schema)
  - 冷却时间: 分钟
  - Backfill 间隔: 秒
- 介面: 繁→简全盘转换 (23 个 UI 文件)

### 新增 (全局进程完全 Web 化, 不再靠 CLI)
- web/lib/tg-login.js 重构: 抽象 target (dept/global) 两种类型
- templates/pages/tg-login.ejs (取代 dept-login.ejs): dept 和 global 共用登入 wizard
- templates/pages/global-edit.ejs: 全局进程编辑页
  - title-sheet-writer: routes 动态多行 UI (新增/删除路由条目)
  - review-report-writer: inputChatNames 逗号分隔 + Sheet + 关键字
  - 每个栏位详细 hint (为什么填 / 填错会怎样 / 范例)
  - 顶部整体业务说明 (这个进程做什么, 写到哪, 用途)
- server.js: /settings/global/:kind/edit + login/phone/code/password/abort routes
- settings.ejs: 去掉 "在 VPS 上跑 CLI" 提示, 加"编辑 / 🔑 登入"按钮


---

## [0.3.0-docker] — 2026-04-17

**Docker 化** — 主推部署方式改成 Docker, 大幅降低跨 OS / 跨 Node 版本的部署坑.
裸跑模式保留作為進階選項.

### 新增
- `Dockerfile` — multi-stage build (Node 22 Alpine + python3/make/g++ builder + pm2@6)
  - tini 作 PID 1 (信號轉發)
  - pm2-runtime 跑 Web, 其他 tg-* 進程由 Web 動態 pm2 start 加載 (同 daemon)
- `docker-compose.yml` — 單容器設計, 5 條 volume mount
  - `depts/` / `global/` / `data/` / `secrets/google-sa.json` / `.backups/` / `.healthcheck/`
  - healthcheck 每 30s curl /health
- `.env.example` — docker-compose 層的非敏感配置範本 (WEB_PORT)
- `install.sh` — 改成 Docker 一鍵裝 (裝 Docker + clone + up --build + 等 healthy)
- `install-bare.sh` — 裸跑模式備胎 (原 install.sh 的 Node + PM2 + nvm 流程)
- `docs/DEPLOY-DOCKER.md` — Docker 部署手冊 (主推)
- `docs/DEPLOY-BARE.md` — 裸跑部署手冊 (進階)

### 改動
- `scripts/update.sh` — 自動偵測模式 (docker / bare), Docker 模式走 `docker compose up -d --build`
  - 備份擴展: depts + data + global + **secrets** 四目錄全備
  - 失敗時 container unhealthy 提示回滾
- `scripts/rollback.sh` — 同步支援 Docker (git reset + docker compose rebuild)
  - 預備份 rollback-safety 也擴展到 4 目錄
  - 回滾後等 container healthy, 否則提示再回滾
- `web/server.js` — 啟動時若 ecosystem.config.js 已有進程定義, 自動 `pm2 start`
  - 容器重啟後既有部門進程自動拉起, 不需人工介入
  - 環境變數 `TG_MONITOR_MULTI_DOCKER=1` 識別 Docker 環境
- `.gitignore` — 加 secrets/ (除 .gitkeep) / .env (除 .env.example) / .healthcheck/
- `README.md` — 改以 Docker 為主, 裸跑指向 docs/DEPLOY-BARE.md

### 設計決策

**單容器 vs 多容器**: 選單容器. N 部門 = 3N+2 進程, 多容器管理爆炸.
同一 pm2 daemon 下, Web 的「重啟按鈕」直接呼叫 `pm2 restart` 即可, 不用走 docker.sock.

**本地 build vs Docker Hub**: 選本地 build. 跟 Docker 版 tg-monitor-template 一致,
不用維護 Docker Hub image, Private repo 配合 `build: .` 最簡單.

**install.sh 不帶參數**: 對齊新的 setup wizard 體驗. 部門名 / port 在 Web 填.

**裸跑保留作備胎**: 對齊用戶 「功能對齊, 部署方式看客戶方便」 原則.
開發者 + 特殊需求用戶可選裸跑, 生產主推 Docker.

### 本機驗證
- `docker compose build` 通過 ✓
- `docker run` 容器 6s healthy ✓
- `/health` + `/setup` 都回 200 ✓
- `bash -n` 所有 shell 腳本過 ✓

### 未做 (留後續)
- VPS 端乾淨實裝驗收 (需用戶提供可用 VPS credentials)
- Docker Hub image 發布 (維持 `build: .` 路線)
- Kubernetes helm chart (非必要)

---

## [0.2.1-mvp] — 2026-04-17

補齊 baseline 架構對齊 — 全局進程 + 健康檢查.

### 新增
- **全局進程支援** (對齊 baseline 有的 2 個全局服務):
  - `global/_template/title-sheet-writer/` 和 `review-report-writer/` 範本
  - `scripts/new-global.js <kind>` CLI 建立全局進程目錄
  - `scripts/login-global.js <kind>` CLI TG 登入 (類比 login-dept)
  - `scripts/generate-ecosystem.js` 擴展掃 `global/` → 生成 `tg-title-sheet-writer` / `tg-review-report-writer` PM2 配置
  - `configVersion: 1` 欄位 (為 schema migration 預留)
- **健康檢查 cron** (對齊 baseline `/root/tg-healthchecks/`):
  - `scripts/healthcheck.sh` 掃 PM2, 非 online → pm2 restart
  - **故意不護 listener** (重啟會掉 TG session, 跟 baseline 同策略)
  - lock 檔防重入, log 5MB 自動輪替
  - `scripts/install-healthcheck.sh install/--status/--remove` cron 管理
- **Web `/settings` 頁**:
  - 全局進程狀態表 + 一鍵建立 / 重啟 / 啟動 / 停止
  - Healthcheck cron 啟用 / 停用開關
  - 系統資訊卡 (版本 / Node / Google SA / PM2 狀態)
  - 備份摘要 (數量 + 總大小)
  - 升級 / 回滾指令對照表

### 架構
- `global/*` 加入 `.gitignore` (除 `_template/` 和 `.gitkeep`)

---

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
