# Deploy · Docker 模式（主推）

## 一鍵裝

```bash
curl -fsSL https://raw.githubusercontent.com/yifan1119/tg-monitor-multi/main/install.sh | bash
```

預設裝到 `/opt/tg-monitor-multi`。想換路徑：

```bash
INSTALL_DIR=~/tg-monitor WEB_PORT=5003 bash install.sh
```

`install.sh` 做：
1. 裝 Docker（若未裝，`get.docker.com` 一行搞定）
2. `git clone` repo 到 `$INSTALL_DIR`
3. 建 `secrets/` + `.env`（docker-compose 用）
4. `docker compose up -d --build`
5. 等 container healthy
6. 印出 `/setup` 網址

## 完成 Setup

開瀏覽器 → `http://<vps-ip>:5003/setup` → 走 4 節嚮導：

1. Web 後台管理員帳密
2. TG API ID / HASH（從 <https://my.telegram.org/apps> 取得）
3. 上傳 `google-service-account.json`
4. 第一個部門（代號 / 名稱 / 中轉群 / Sheet ID / 分頁名）

Setup 完會自動建立 `depts/<第一個部門>/` 目錄。

## 完成 TG 登入

Dashboard → 點部門卡進 edit → 「🔑 去登入 TG」 → 填手機號 → 驗證碼 → （若有）2FA 密碼。

## 啟動部門進程

編輯頁 → 「▶ 啟動」。

## 日常指令

```bash
cd /opt/tg-monitor-multi

docker compose ps              # 看容器狀態
docker compose logs -f         # 實時 log (含 pm2 所有進程)
docker compose logs -f --tail=100
docker compose restart         # 重啟整個容器 (含所有 tg-*)
docker compose down            # 停止 (volume 保留, 資料不丟)
docker compose down -v         # 停止 + 刪 volume ⚠️ 會刪 depts/

bash scripts/update.sh         # 升級 (自動走 Docker)
bash scripts/rollback.sh       # 回滾
bash scripts/list-backups.sh   # 列備份
```

## Volume / 資料結構

```
<INSTALL_DIR>/
├── depts/                   ← 部門 (mount 進容器 /app/depts)
├── global/                  ← 全局進程 (/app/global)
├── data/                    ← 系統設置 (/app/data)
├── secrets/
│   └── google-service-account.json  ← Google SA (mount 到 /app/shared/...)
├── .backups/                ← update.sh 備份
└── .healthcheck/            ← healthcheck log (若啟用)
```

**R3 契約**：升級 / 回滾 / rebuild 容器時，這些 volume 資料**絕不動**。

## 架構（單容器）

```
Container: tg-monitor-multi
├── tini (PID 1)
└── pm2-runtime
    ├── tg-monitor-web           (web/server.js, port 5003)
    ├── tg-listener-<dept1>
    ├── tg-system-events-<dept1>
    ├── tg-sheet-writer-<dept1>
    ├── tg-listener-<dept2>      (Setup / 新增部門後動態加載)
    └── ... 所有部門和全局進程同一個 pm2 daemon
```

Web 的「重啟 / 停止 / 新增部門」按鈕直接呼叫容器內 `pm2` — **不用走 docker.sock**。

## 記憶體限制（可選）

避免單容器吃光 VPS 記憶體，編輯 `docker-compose.yml` 取消註解：

```yaml
deploy:
  resources:
    limits:
      memory: 4G
```

建議 2G + 每部門 300M 估算（例如 9 部門 = 2 + 9×0.3 ≈ 5G）。

## 公網 HTTPS

容器只 expose `5003` HTTP。對公網建議走外部反代：

### 方案 A：Cloudflare Tunnel（推薦，無 domain 可用）

```bash
docker run --rm -d --name cloudflared --network tg-monitor-multi_default \
  cloudflare/cloudflared:latest tunnel --url http://tg-monitor:5003
```

### 方案 B：Caddy 反代 + Let's Encrypt

在 `docker-compose.yml` 加一個 Caddy service 對外 443，upstream 指到 `tg-monitor:5003`。

### 方案 C：SSH tunnel（個人用）

```bash
ssh -L 5003:localhost:5003 user@<vps-ip>
# 本地開 http://localhost:5003
```

## 疑難排解

| 症狀 | 檢查 |
|------|------|
| container 一直 unhealthy | `docker compose logs --tail=100` |
| port 5003 已被占用 | 改 `.env` 的 `WEB_PORT=5004` + `docker compose up -d` |
| Google SA 上傳失敗 | 看 `secrets/google-service-account.json` 檔案權限 / 容器是否有 write 權限 |
| TG 登入 wizard 卡在驗證碼 | 容器內網路不通 TG → 檢查 VPS 是否被擋 TG API |
| 升級後 pm2 沒拉起 tg-* 進程 | `docker compose exec tg-monitor pm2 list` 手動檢查 |

## 完全移除

```bash
cd /opt/tg-monitor-multi
docker compose down -v       # 會刪 volume 裡的 named volume (但 bind mount 不動)
cd /
rm -rf /opt/tg-monitor-multi # 刪整個專案 (含 depts/session.txt 等, 先備份!)
```
