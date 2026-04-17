# Deploy · 裸跑模式（進階）

**主推用 Docker 模式**（見 [DEPLOY-DOCKER.md](DEPLOY-DOCKER.md)）。本文給以下情境：

- 開發者本地 debug
- VPS 已有 PM2 生態，不想再加 Docker
- 跨專案整合 PM2 namespace

## 一鍵裝

```bash
curl -fsSL https://raw.githubusercontent.com/yifan1119/tg-monitor-multi/main/install-bare.sh | bash
```

會裝：
1. Node 22（via nvm，不污染系統）
2. PM2 全域
3. clone repo
4. `npm ci`（workspaces）

## 手動裝

```bash
# 1. Node 22（建議 nvm）
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 22 && nvm use 22

# 2. PM2
npm install -g pm2

# 3. clone + deps
git clone https://github.com/yifan1119/tg-monitor-multi.git /opt/tg-monitor-multi
cd /opt/tg-monitor-multi
npm ci   # 一次裝 shared + web (workspaces)

# 4. 初始化目錄
mkdir -p depts data global .backups .healthcheck
```

## 啟動

```bash
cd /opt/tg-monitor-multi/web
pm2 start server.js --name tg-monitor-web
pm2 save
pm2 startup           # 照提示跑 sudo 指令 (systemd 自啟)
```

## 完成 Setup

同 Docker 模式：開 `http://<vps-ip>:5003/setup`。

## 新增部門 CLI（可選，Web 能做）

```bash
cd /opt/tg-monitor-multi
node scripts/new-dept.js yueda "悦达" "悦达-业务审查" 1ABC "关键词提醒yd"

# TG 登入 (CLI):
cd depts/yueda && node ../../scripts/login-dept.js yueda

# 重生 ecosystem:
node scripts/generate-ecosystem.js

# 啟動該部門:
pm2 start ecosystem.config.js --only tg-listener-yueda,tg-system-events-yueda,tg-sheet-writer-yueda
```

## 日常指令

```bash
pm2 list                       # 所有進程
pm2 logs                       # 實時 log
pm2 logs tg-listener-yueda     # 單進程 log
pm2 restart tg-listener-yueda  # 重啟某進程
pm2 monit                      # 即時監控

bash scripts/update.sh         # 升級 (自動偵測走裸跑)
bash scripts/rollback.sh       # 回滾
```

## 多專案共用 VPS

裸跑模式可以跟別的 PM2 專案共存。用 namespace 分組：

```bash
# 啟動時指定 namespace
pm2 start ecosystem.config.js --namespace tg-monitor

# 之後對整組操作
pm2 restart tg-monitor         # 重啟整個 namespace
pm2 logs tg-monitor            # 看整組 log
pm2 stop tg-monitor            # 停整組
```

或每專案一個目錄 + 端口隔離：

```
/opt/tg-monitor-multi/   (port 5003)
/opt/other-project/      (port 5010)
...
```

## HTTPS

port 5003 預設只 HTTP，建議用外部反代（Caddy / Cloudflare Tunnel / Nginx + Let's Encrypt），參考 [DEPLOY-DOCKER.md#公網-https](DEPLOY-DOCKER.md#公網-https)。

## 升級 / 回滾

`scripts/update.sh` 和 `scripts/rollback.sh` 會**自動偵測**當前模式（有 docker-compose.yml 且 Docker 可用 = Docker mode，否則 bare mode）。

想強制裸跑模式：

```bash
UPDATE_MODE=bare bash scripts/update.sh
ROLLBACK_MODE=bare bash scripts/rollback.sh <backup>
```

## 完全移除

```bash
pm2 delete tg-monitor-web
pm2 delete tg-*               # 刪所有部門進程
pm2 save
rm -rf /opt/tg-monitor-multi  # 含 depts/session.txt, 先備份!
```
