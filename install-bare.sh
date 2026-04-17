#!/usr/bin/env bash
# install-bare.sh — 裸跑模式安裝 (進階選項, 不用 Docker)
#
# 主推用 install.sh (Docker 模式). 本檔案給想要原生 Node + PM2 跑的用:
#   - 開發者本地 debug 方便
#   - VPS 已經有 pm2 生態不想加 Docker
#   - 特別場景 (如需要 pm2 namespace 跨專案整合)
#
# 用法:
#   bash install-bare.sh
#
#   # 可配置:
#   INSTALL_DIR=/opt/tg-monitor-multi BRANCH=main NODE_VERSION=22 bash install-bare.sh

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
echo "  tg-monitor-multi · 裸跑模式安裝 (進階選項)"
echo "═══════════════════════════════════════════════════"
echo -e "${c_reset}"
echo "  INSTALL_DIR: $INSTALL_DIR"
echo "  NODE:        v$NODE_VERSION"
echo "  WEB_PORT:    $WEB_PORT"
echo ""
echo -e "${c_yellow}⚠${c_reset} 主推用 Docker 模式 (bash install.sh). 確定要裸跑?"
echo "  continue / Ctrl+C"
read -r _

for cmd in git curl; do
  command -v "$cmd" >/dev/null || { err "$cmd 未裝"; exit 1; }
done

# ─── Node.js via nvm ─────────────────────────────
install_node_via_nvm() {
  log "裝 Node $NODE_VERSION via nvm..."
  export NVM_DIR="$HOME/.nvm"
  [[ ! -d "$NVM_DIR" ]] && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # shellcheck disable=SC1090
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
  nvm alias default "$NODE_VERSION"
}

if command -v node >/dev/null; then
  major=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ $major -ge $NODE_VERSION ]]; then ok "Node $(node -v)"; else install_node_via_nvm; fi
else
  install_node_via_nvm
fi

# ─── PM2 ─────────────────────────────────────────
if ! command -v pm2 >/dev/null; then
  npm install -g pm2
fi
ok "PM2 $(pm2 -v)"

# ─── clone ───────────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  warn "$INSTALL_DIR 已存在, pull 更新"
  (cd "$INSTALL_DIR" && git pull --ff-only)
else
  [[ -d "$INSTALL_DIR" ]] && [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]] && {
    err "$INSTALL_DIR 非空"
    exit 1
  }
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ─── npm ci (workspaces) ─────────────────────────
log "裝依賴 (npm ci, workspaces)..."
npm ci --silent

# 腳本權限
chmod +x scripts/*.sh install.sh install-bare.sh 2>/dev/null || true

# 初始化 (裸跑也需要這些目錄)
mkdir -p depts data global .backups .healthcheck
[[ -f shared/google-service-account.json ]] || echo '{}' > shared/google-service-account.json

VERSION=$(cat VERSION 2>/dev/null || echo "?")
VPS_IP=$(curl -fsSL --max-time 3 https://ipinfo.io/ip 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_VPS_IP")

echo ""
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo -e "${c_green}${c_bold}  ✓ 裸跑模式安裝完成 · v$VERSION${c_reset}"
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo ""
echo "下一步:"
echo ""
echo -e "  1. 啟動 Web:"
echo -e "     ${c_cyan}cd $INSTALL_DIR/web && pm2 start server.js --name tg-monitor-web${c_reset}"
echo -e "     ${c_cyan}pm2 save${c_reset}"
echo ""
echo -e "  2. 開機自啟: ${c_cyan}pm2 startup${c_reset}"
echo ""
echo -e "  3. 開瀏覽器: ${c_cyan}http://$VPS_IP:$WEB_PORT/setup${c_reset}"
echo ""
echo "升級 / 回滾會自動偵測裸跑模式:"
echo -e "  ${c_cyan}bash scripts/update.sh${c_reset}"
echo -e "  ${c_cyan}bash scripts/rollback.sh${c_reset}"
echo ""
