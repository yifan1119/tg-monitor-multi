#!/usr/bin/env bash
# install.sh — 從零裝新 VPS
#
# 用法 (在乾淨 Ubuntu / Debian):
#   curl -fsSL https://raw.githubusercontent.com/yifan1119/tg-monitor-multi/main/install.sh | bash
#
#   # 或指定安裝目錄 + 分支:
#   INSTALL_DIR=/opt/tg-monitor-multi BRANCH=main bash install.sh
#
# 做什麼:
#   1. 檢查 / 裝 Node 22 LTS (透過 nvm, 不污染系統)
#   2. 檢查 / 裝 pm2 (全域 npm)
#   3. git clone tg-monitor-multi 到 $INSTALL_DIR
#   4. cd shared && npm ci
#   5. cd web && npm ci
#   6. (不自動啟動. 引導用戶走 Web setup 填第一個部門)

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/tg-monitor-multi}"
REPO_URL="${REPO_URL:-https://github.com/yifan1119/tg-monitor-multi.git}"
BRANCH="${BRANCH:-main}"
NODE_VERSION="${NODE_VERSION:-22}"
WEB_PORT="${WEB_PORT:-5003}"

c_green='\033[0;32m'; c_yellow='\033[0;33m'; c_red='\033[0;31m'
c_cyan='\033[0;36m'; c_bold='\033[1m'; c_reset='\033[0m'

log()  { echo -e "${c_cyan}▸${c_reset} $*"; }
ok()   { echo -e "${c_green}✓${c_reset} $*"; }
warn() { echo -e "${c_yellow}⚠${c_reset} $*"; }
err()  { echo -e "${c_red}✗${c_reset} $*" >&2; }

echo -e "${c_bold}"
echo "═══════════════════════════════════════════════════"
echo "  tg-monitor-multi · install"
echo "═══════════════════════════════════════════════════"
echo -e "${c_reset}"
echo "  INSTALL_DIR: $INSTALL_DIR"
echo "  REPO:        $REPO_URL ($BRANCH)"
echo "  NODE:        v$NODE_VERSION"
echo "  WEB_PORT:    $WEB_PORT"
echo ""

# ─── 預檢 ──────────────────────────────────────────
if [[ $EUID -eq 0 ]]; then
  warn "root 執行中"
fi

# 必備工具
for cmd in git curl; do
  if ! command -v "$cmd" >/dev/null; then
    err "$cmd 未裝. 請先裝: apt-get install -y $cmd"
    exit 1
  fi
done

# ─── 1. Node.js ────────────────────────────────────
log "檢查 Node.js..."
install_node_via_nvm() {
  log "透過 nvm 裝 Node $NODE_VERSION..."
  export NVM_DIR="$HOME/.nvm"
  if [[ ! -d "$NVM_DIR" ]]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1090
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
  nvm alias default "$NODE_VERSION"
}

if command -v node >/dev/null; then
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ $NODE_MAJOR -ge $NODE_VERSION ]]; then
    ok "Node $(node -v) 已安裝"
  else
    warn "Node $(node -v) 版本過舊, 升級中..."
    install_node_via_nvm
    ok "Node $(node -v)"
  fi
else
  install_node_via_nvm
  ok "Node $(node -v)"
fi

# ─── 2. PM2 ────────────────────────────────────────
log "檢查 PM2..."
if ! command -v pm2 >/dev/null; then
  npm install -g pm2
  ok "PM2 $(pm2 -v)"
else
  ok "PM2 $(pm2 -v) 已安裝"
fi

# ─── 3. clone ──────────────────────────────────────
log "準備安裝目錄: $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  warn "$INSTALL_DIR 已存在 git repo, 跳過 clone"
  warn "如需重裝, 先 rm -rf $INSTALL_DIR 再跑"
else
  if [[ -d "$INSTALL_DIR" ]] && [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]]; then
    err "$INSTALL_DIR 存在且非空, 無法 clone. 請清空或換目錄 (INSTALL_DIR=...)"
    exit 1
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  ok "clone 完成"
fi

cd "$INSTALL_DIR"

# ─── 4. 裝依賴 ────────────────────────────────────
log "裝 shared/ 依賴..."
(cd "$INSTALL_DIR/shared" && npm ci --silent)
ok "shared/ OK"

log "裝 web/ 依賴..."
(cd "$INSTALL_DIR/web" && npm ci --silent)
ok "web/ OK"

# ─── 5. chmod 腳本 ─────────────────────────────────
chmod +x "$INSTALL_DIR/scripts/"*.sh "$INSTALL_DIR/install.sh" 2>/dev/null || true

# ─── 6. 完成 ───────────────────────────────────────
VERSION=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "?")

echo ""
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo -e "${c_green}${c_bold}  ✓ 安裝完成 · v$VERSION${c_reset}"
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo ""
echo "下一步:"
echo ""
echo -e "  1. 啟動 Web 後台 (推薦用 PM2 託管):"
echo -e "     ${c_cyan}cd $INSTALL_DIR/web && pm2 start server.js --name tg-monitor-web${c_reset}"
echo -e "     ${c_cyan}pm2 save${c_reset}"
echo ""
echo -e "  2. 開機自啟:"
echo -e "     ${c_cyan}pm2 startup${c_reset}  (照提示跑一行 sudo 指令)"
echo ""
echo -e "  3. 開瀏覽器:"
echo -e "     ${c_cyan}http://<your-vps-ip>:$WEB_PORT${c_reset}"
echo -e "     → 走 Setup Wizard 填 TG API / Google SA / 第一個部門"
echo ""
echo "日常操作:"
echo -e "  升級:  ${c_cyan}bash $INSTALL_DIR/scripts/update.sh${c_reset}"
echo -e "  回滾:  ${c_cyan}bash $INSTALL_DIR/scripts/rollback.sh${c_reset}"
echo -e "  備份:  ${c_cyan}bash $INSTALL_DIR/scripts/list-backups.sh${c_reset}"
echo ""
echo "安全提醒:"
echo -e "  ${c_yellow}⚠${c_reset} port $WEB_PORT 建議只對內網開放 (防火牆擋公網)"
echo -e "  ${c_yellow}⚠${c_reset} 要公網訪問, 用 Cloudflare Tunnel / SSH tunnel / Caddy + HTTPS"
echo -e "  ${c_yellow}⚠${c_reset} depts/*/session.txt 是 TG 登入憑證, 建議另存加密備份"
echo ""
