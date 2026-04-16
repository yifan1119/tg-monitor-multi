# tg-monitor-multi

多部門 Telegram 群組監控系統模板。
**一台 VPS 可承載 N 個部門/中心**，每部門一套 TG 號 + 中轉群 + Google Sheet。

對齊 Docker 版 `tg-monitor-template`（外事號私聊監控），本 repo 聚焦**業務群監控**場景：
商務人員在客戶群裡談案子，當消息命中關鍵字（到期/下架/打款/欠費等）自動推提醒 + 寫表格。

## 狀態

🚧 **v0.2.0-mvp-dev** — 7 天 MVP 開發中 (2026-04-16 啟動, 預計 4/23 交付)

| 里程碑 | 交付日 | 狀態 |
|--------|--------|------|
| D1 — 骨架搭建 | 4/16 | 🚧 進行中 |
| D2 — new-dept CLI | 4/17 | ⏳ |
| D3 — Web setup/login | 4/18 | ⏳ |
| D4 — Dashboard 總覽 | 4/19 | ⏳ |
| D5 — 部門編輯/新增表單 | 4/20 | ⏳ |
| D6 — install.sh + 乾淨 VPS 驗收 | 4/21 | ⏳ |
| D7 — README + demo | 4/22 | ⏳ |

完整路線圖見 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 架構

```
tg-monitor-multi/
├── shared/                   # 5 個主進程共用代碼 + 一份 node_modules
│   ├── listener.js           # TG 群關鍵字監聽
│   ├── system_events.js      # 群系統事件監聽
│   ├── sheet_writer.js       # 寫 Google Sheet
│   ├── title_sheet_writer.js # 群名變更彙總（全局）
│   └── review_report_writer.js # 審查日報（全局）
│
├── web/                      # Express 管理後台 (port 5003)
│
├── depts/                    # 多部門配置
│   ├── _template/            # 新增部門的範本
│   └── <dept_name>/          # 每部門一目錄（只存差異）
│       ├── config.json
│       ├── .env              # TG_API_ID / TG_API_HASH
│       ├── session.txt       # gram.js StringSession
│       └── state/
│
├── data/                     # Web 用戶 + 系統設置
├── scripts/                  # CLI 工具
└── docs/                     # 架構文檔 + 路線圖
```

## 快速啟動（MVP 完成後）

```bash
# 1. 一鍵安裝（D6 完成後可用）
curl -fsSL https://raw.githubusercontent.com/yifan1119/tg-monitor-multi/main/install.sh | bash

# 2. 或手動
git clone git@github.com:yifan1119/tg-monitor-multi.git
cd tg-monitor-multi
npm run install:all
npm run web
# 開瀏覽器 → http://<vps>:5003 → setup wizard
```

## 跟 Docker 版的差別

| 維度 | Docker 版 (`tg-monitor-template`) | Node 版 (本 repo) |
|------|-------------------------------|-------------------|
| 場景 | 外事號**私聊**監控 | 業務**群**監控 |
| 部署粒度 | 1 客戶 1 VPS | 1 VPS × N 部門 |
| 技術棧 | Python+Telethon+SQLite+Flask+Docker | Node+gram.js+JSON+Express+PM2 |
| 儲存 | SQLite | 純 JSON 檔 + Google Sheets |

## 敏感檔（已 .gitignore）

| 檔案 | 說明 |
|------|-----|
| `*/.env` | TG_API_ID / TG_API_HASH |
| `*/session.txt` | Telegram 登入憑證（洩漏=號被接管） |
| `shared/google-service-account.json` | Google Cloud SA 私鑰 |
| `data/users.json` | Web 後台用戶 bcrypt hash |

## Baseline 來源

代碼抽自 `yifan1119/tg-monitor-node` (baseline commit `41ac92b`)，該 repo 為歷史 snapshot，不再更新。

## 相關

- Docker 版：[yifan1119/tg-monitor-template](https://github.com/yifan1119/tg-monitor-template)
- Baseline：[yifan1119/tg-monitor-node](https://github.com/yifan1119/tg-monitor-node)
