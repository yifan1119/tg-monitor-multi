# Changelog

所有版本的變更記錄。遵循 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/) 與 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

<!-- 版本紀律: 每次發版必須在此加一行. 違反 R6 兼容契約 (見 ARCHITECTURE.md) -->

## [0.4.0-docker] — 2026-04-17

**合并架构** — 每部门 3 进程 → 1 worker, 全局 2 砍 1. **进程 29→10, TG 号 20→10**.

### 设计原则
业务功能 0 丢失, 只优化底层结构.

### 新增
- **`shared/worker.js`** (三合一) — 每部门 1 个 worker 合并原 listener + system-events + sheet-writer:
  - 监听业务群消息 → 命中关键字 → 推中转群 + 直接写 keywordSheet
  - 群名变更 (event + 文本两种形式) → 推中转群 + 写 titleSheet (若配)
  - **不需要订阅中转群作 IPC** — 命中直接写 Sheet, 中转群只做人类可见提醒
  - 写 Sheet 失败 → retry 3 次 → 仍失败落盘 `state/pending-writes.jsonl`, 每 60s 重试
  - 每 60s backfill 扫业务群最近 30 条 (防 event stream 漏)
  - v1 config.json 自动 migration 到 v2 schema (旧 spreadsheetId/sheetName → keywordSheet{...})
- **titleSheet 可选新字段** — 想把群名变更也写 Sheet 的话在 config 加 `titleSheet: {spreadsheetId, sheetName}`

### 改动
- `scripts/generate-ecosystem.js`: `DEPT_KINDS = [{kind: "worker"}]` (从 3 类改 1 类)
- `scripts/new-global.js`: `KINDS = ["review-report-writer"]` (砍 title-sheet-writer)
- Web UI: 部门列表 / 编辑页 / 日志面板 从 3 进程改成 1 worker
- Dashboard 健康灯: 部门总进程数 = 部门数 × 1 (从 × 3 改)
- `data-provider.js`: 识别 `tg-worker-*` 进程名

### 砍掉
- **`title-sheet-writer` 全局进程** — 每个 dept worker 自己写群名变更到本部门 Sheet, 不再需要跨部门订阅分流
- **号 B / 号 C** (每部门 sheet-writer 号 + 全局 title 号)
- baseline 每部门 3 份 session.txt → **1 份**

### 保留
- **`review-report-writer` 全局进程** — 跨部门审查报告闭环配对 (代码按 reviewNo 全局找行, 不 check 来自哪个群, 业务功能真实存在)
- 中转群 — 保留作**人类可见实时提醒**, 不再作 IPC 队列
- 原 shared/listener.js / system_events_listener.js / sheet_writer.js / title_sheet_writer.js — 保留在仓库 (R 契约兼容), 不被 ecosystem 调用

### 兼容
- 旧 config.json (v1 schema) 由 worker loadConfig() 自动映射到 v2, 无需人工迁移
- v0.3.x 已建立的 depts/ + global/ 目录继续能用

### 数字对比

| | v0.3.4 | v0.4.0 | 节省 |
|---|---|---|---|
| 每部门进程数 | 3 | 1 | -67% |
| 9 部门 + 全局总进程 | 29 | 10 | -65% |
| 每部门 TG 号 | 2 | 1 | -50% |
| 9 部门 + 全局总号数 | 20 | 10 | -50% |
| 每部门登入次数 | 3 | 1 | -67% |

---

## [0.3.4-docker] — 2026-04-17

**零 CLI 系列 #3** — TG 群下拉 · 关键字预览 · Dashboard 健康摘要.

### 新增
- **TG 群选择器** — 用已登入的 session 拉该号加入的 dialogs, 给输入框做 datalist 建议
  - 部门编辑页 · 中转群字段: 「🔍 从该号加入的群选」按钮
  - 全局 title-sheet-writer 编辑页 · routes: 每条路由的「中转群名称」都得 datalist
  - 60s 内存快取 (防 TG 流控)
  - `web/lib/tg-dialogs.js` 新增
  - `GET /api/tg-dialogs/dept/:name` + `GET /api/tg-dialogs/global/:kind`
- **关键字命中预览** — 部门编辑页 · 关键字 panel 下
  - 测试文本 textarea + 实时命中高亮 (黄色 mark)
  - 显示命中关键字列表 + 命中计数
- **Dashboard 健康摘要卡** — 总览页顶部一排灯
  - 部门进程 (X/Y online + 几个需登入) · 全局进程 · Healthcheck · 备份 (最近 N 天前) · Google SA
  - 绿 / 黄 / 灰 / 红 分档, 一眼看完整体健康

---

## [0.3.3-docker] — 2026-04-17

**零 CLI 系列 #2** — 实时日志 · 部门复制 · 连线测试.

### 新增
- **实时日志面板** — `/depts/:name/edit` + `/settings/global/:kind/edit` 底部
  - 读 `state/<kind>.out.log` / `state/<kind>.error.log` 尾部 (只读 256KB 防 OOM)
  - 标签切换不同进程 (listener / system-events / sheet-writer)
  - stdout / stderr 切换, 3 秒自动刷新 (可关)
  - 自动跟随新行 (除非用户手动上滚查看历史)
  - `web/lib/log-reader.js` 新增
  - `web/templates/partials/log-panel.ejs` 新增 (dept 和 global 共用)
  - `GET /api/logs/dept/:name/:kind?type=out|err&lines=150`
  - `GET /api/logs/global/:kind?type=out|err&lines=150`
- **复制部门快捷按钮** — 部门列表每行 + 「📋 复制」
  - `/depts/new?template=<name>` 从该部门读 config 预填表单 (除 dept_name 外)
  - 顶部提示「正以 xxx 为模板」
- **连线测试按钮**:
  - 部门编辑页 Sheet 下 + 「🧪 测试 Sheet 写入」: 写一行 + 立刻删掉 + 回报成功/失败
  - 全局 review-report-writer 编辑页同样有
  - 系统设置 · Google SA 栏 + 「🧪 测试连线」: 调 drive.about.get 回报 OK
  - `web/lib/connection-tester.js` 新增
  - `POST /api/test/sheet` + `POST /api/test/gsa`

---

## [0.3.2-docker] — 2026-04-17

**零 CLI 系列 #1** — session 复用 + Web 一键升级回滚 + ecosystem 自启对齐.

### 新增
- **Session 复制** — TG 登入 wizard (dept + global) step=phone 顶新增「快速方式」block
  - 下拉选已登入的 session → 一键复制 session.txt 过去 (不走验证码)
  - 对齐苏总原设计: baseline 的 sheet-writer + system-events 本来就共用同一份 session.txt
  - `web/lib/tg-login.js` 新增 `listAvailableSessions()` / `copySessionFrom()`
  - `server.js` 新增 `POST /depts/:name/login/copy` + `POST /settings/global/:kind/login/copy`
- **Web 升级 / 回滚** (`/settings`):
  - 「🔍 检查更新」按钮: git fetch + 比对 → 显示落后 commit 数 + commits 列表
  - 软升级 (代码变更): 自动备份 → git pull → regen ecosystem → pm2 reload tg-* (Web 自己不重启)
  - 硬升级 (Dockerfile/package.json 变动): 提示需 SSH 跑 `bash scripts/update.sh`
  - 备份表格: 每个备份显示时间/大小/包含目录 + 一键回滚按钮
  - 回滚前自动预备份到 `.backups/<ts>-pre-rollback/` (防回滚也出错)
  - `web/lib/update-manager.js` 新增
  - `web/templates/pages/update-result.ejs` 新增 (日志输出页)
- **ecosystem 自启对齐** — Web 启动时 (容器 boot / 升级后) 先跑 `generate-ecosystem.js`, 再 `pm2 start`
  - 修复 v0.3.1 Docker rebuild 后 ecosystem.config.js 不同步的问题

### 改动
- `/settings` 去掉 CLI 命令对照表, 改成真正可点的「检查更新 / 回滚」按钮
- `/settings/global/new` flash 从「SSH 跑 login-global.js」改成「编辑页 + 🔑 登入」
- `/dashboard` 空状态快速上手从「跑 login-dept.js」改成「点编辑页 🔑」
- `/depts/new` 成功页从「手动登入 + pm2 start」改成「编辑页 🔑 (可复制 session) + ▶ 启动」

---

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
