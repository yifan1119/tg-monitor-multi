# Roadmap

## v0.2.0-mvp (開發中, 4/23 交付)

**目標**：空模板可 clone 到乾淨 VPS，從零填第一個部門並跑起來。對齊 Docker 版 `tg-monitor-template` 的產品體驗。

### 7 天計劃

| 天 | 日期 | 工作 | 可驗證產出 |
|----|------|------|-----------|
| D1 | 4/16 | 骨架搭建 + shared/ copy 5 腳本 + depts/_template + .gitignore + README | repo 骨架推上 GitHub |
| D2 | 4/17 | `new-dept.sh` 完整版 + `login-dept.js` 可用 + ecosystem 生成器 | `bash scripts/new-dept.sh test-dept` 能生成完整目錄 + login 能拿 session |
| D3 | 4/18 | `web/server.js` + `/login` + `/setup` wizard + 霓虹風 CSS | 本地 localhost:5003 開得了設置頁，走完 wizard 能建第一個部門 |
| D4 | 4/19 | `/dashboard` + PM2 狀態表 + 動態列出部門 + 霓虹風成品 | 本地 dashboard（mock / 真實 PM2 數據擇一） |
| D5 | 4/20 | `/depts/:name/edit` + 新增部門 Web 表單 + 保存即重啟 | 本地完整體驗「新增→編輯→重啟」 |
| D6 | 4/21 | `install.sh` + 乾淨 VPS 測試（見下方選項） | 從零 `curl \| bash` 裝出可用實例 |
| D7 | 4/22 | README 完整 + 錄 30 秒 demo + CHANGELOG | 交付 |
| 緩衝 | 4/23 | 修 bug + MVP 驗收 + 給苏总看 | v0.2.0-mvp tag |

### MVP 不做（留後續）

- ❌ RBAC（先全局單密碼）
- ❌ TG 登入 Web 化（D3 先用 CLI `login-dept.js`，Web 化留 v0.3）
- ❌ 告警 / heartbeat / 實時日誌流
- ❌ 配置驗證 (pre-save check spreadsheet 可達)
- ❌ 安全強化（CSRF / rate limit）
- ❌ Docker 版額外功能（未回覆預警 / 刪消息檢測 / 日報）
- ❌ 9 部門實機遷移（這是 **另一條 PR**，不在 MVP）

### MVP 預設值

| 設計決策 | MVP 採用 |
|---------|---------|
| 5 進程合併？ | ❌ 維持 5 類（降風險） |
| 補 Docker 版功能？ | ❌ 不補 |
| 視覺對齊？ | ✅ 直接 copy `tg-monitor-template` templates + CSS |
| dept-admin 分權？ | ❌ 先全局單密碼 |

### D6 乾淨 VPS 測試選項

- 你的 76.13.219.163 開 `/root/tg-monitor-multi-test/`（最可控）
- Marco VPS 187.77.158.205（客戶 VPS, 謹慎）
- 臨時 Hetzner / Vultr（最乾淨, 測完銷毀）
- 本地 Docker 模擬 Ubuntu

---

## v0.3 (MVP 後第一次迭代)

**候選項目**（待 MVP 結束後挑選優先順序）：

### 安全 / 認證
- [ ] RBAC（管理員 + 普通用戶，複用 Docker 版 users.json 邏輯）
- [ ] 防暴力破解（10 分鐘 5 次失敗 → 鎖 15 分鐘）
- [ ] CSRF / session 超時

### 功能補齊
- [ ] TG 登入 Web 化（`/depts/:name/login` 整合 verify-code 流程）
- [ ] 配置驗證（pre-save check spreadsheet 可達、群名存在、關鍵字合法）
- [ ] 刪部門功能（含資料歸檔）
- [ ] 操作審計 log

### 運維
- [ ] heartbeat 檔案（listener / sheet-writer 每分鐘寫，Web 檢 mtime）
- [ ] 告警推 TG（log error → 推部門 TG 群）
- [ ] 實時日誌流（`/logs/:name` WebSocket）
- [ ] 日誌輪替壓縮

### 9 部門實機遷移（獨立 PR）
- [ ] 在 76.13.215.38 建 `/root/tg-monitor-multi/` 並行
- [ ] 遷移腳本（dry-run + 回滾 + 進度 log）
- [ ] 逐部門灰度切
- [ ] 舊結構保留 30 天

---

## v0.4+

- Docker 版額外功能（未回覆預警 / 刪消息檢測 / 每日日報）
- Google Sheet API client 池化（省 quota）
- session.txt 加密備份（age / gpg）
- install.sh 優化（自動裝 Node / PM2 / 依賴）
- HTTPS 建議（Caddy / Cloudflare Tunnel 整合文檔）

---

## v1.0 (對外版)

- Public / Private 決定
- 文檔完整（部署 / 運維 / 故障排除）
- 示範視頻
- 乾淨 VPS 從零裝一次全綠
- 通過 OWASP Top 10 自檢
