#!/usr/bin/env bash
# install.sh — 一鍵部署 (Docker 模式, 主推)
#
# 裸跑模式: 見 install-bare.sh (進階 / 開發者用)
#
# 用法 (乾淨 Ubuntu / Debian):
#   curl -fsSL https://raw.githubusercontent.com/yifan1119/tg-monitor-multi/main/install.sh | bash
#
#   # 可配置:
#   INSTALL_DIR=/opt/tg-monitor-multi \
#   REPO_URL=https://github.com/yifan1119/tg-monitor-multi.git \
#   BRANCH=main \
#   WEB_PORT=5003 \
#   bash install.sh
#
# 做什麼:
#   1. 裝 Docker (若未裝)
#   2. git clone repo
#   3. 初始化 secrets/ 和 .env
#   4. docker compose up -d --build
#   5. 等 container healthy
#   6. 印出 Web 設置嚮導網址

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/tg-monitor-multi}"
REPO_URL="${REPO_URL:-https://github.com/yifan1119/tg-monitor-multi.git}"
BRANCH="${BRANCH:-main}"
WEB_PORT="${WEB_PORT:-5003}"

c_green='\033[0;32m'; c_yellow='\033[0;33m'; c_red='\033[0;31m'
c_cyan='\033[0;36m'; c_bold='\033[1m'; c_reset='\033[0m'

log()  { echo -e "${c_cyan}▸${c_reset} $*"; }
ok()   { echo -e "${c_green}✓${c_reset} $*"; }
warn() { echo -e "${c_yellow}⚠${c_reset} $*"; }
err()  { echo -e "${c_red}✗${c_reset} $*" >&2; }

echo -e "${c_bold}"
echo "═══════════════════════════════════════════════════"
echo "  tg-monitor-multi · Docker install"
echo "═══════════════════════════════════════════════════"
echo -e "${c_reset}"
echo "  INSTALL_DIR: $INSTALL_DIR"
echo "  REPO:        $REPO_URL ($BRANCH)"
echo "  WEB_PORT:    $WEB_PORT"
echo ""

if [[ $EUID -ne 0 ]] && [[ -z "${SUDO_USER:-}" ]]; then
  warn "建議用 root 或 sudo 跑 (裝 Docker 需要)"
fi

# ─── 必備工具 ──────────────────────────────────────
for cmd in git curl; do
  if ! command -v "$cmd" >/dev/null; then
    err "$cmd 未裝. 請先: apt-get install -y $cmd  或  yum install -y $cmd"
    exit 1
  fi
done

# ─── 1. 裝 Docker ──────────────────────────────────
if ! command -v docker >/dev/null; then
  log "裝 Docker (透過 get.docker.com)..."
  curl -fsSL https://get.docker.com | sh
  ok "Docker 已裝"
else
  ok "Docker 已存在: $(docker -v)"
fi

# 確認 docker compose plugin
if ! docker compose version >/dev/null 2>&1; then
  err "docker compose v2 plugin 不可用."
  err "  Linux: Docker 20.10+ 內建; 若沒有, 另裝: apt-get install -y docker-compose-plugin"
  exit 2
fi
ok "docker compose: $(docker compose version --short)"

# 確認 Docker daemon 跑著
if ! docker info >/dev/null 2>&1; then
  log "Docker daemon 未跑, 啟動..."
  systemctl start docker 2>/dev/null || service docker start 2>/dev/null || {
    err "無法啟動 Docker. 手動: systemctl start docker"
    exit 3
  }
fi

# ─── 2. git clone ──────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  warn "$INSTALL_DIR 已有 repo, git pull 拉最新"
  (cd "$INSTALL_DIR" && git pull --ff-only)
else
  if [[ -d "$INSTALL_DIR" ]] && [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]]; then
    err "$INSTALL_DIR 非空且非 git repo, 無法 clone. 清空或換目錄 (INSTALL_DIR=...)"
    exit 1
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  log "clone $REPO_URL → $INSTALL_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  ok "clone 完成"
fi

cd "$INSTALL_DIR"

# ─── 3. 初始化 secrets/ 和 .env ────────────────────
mkdir -p secrets .backups .healthcheck data depts global

# google-service-account.json 佔位檔 (bind mount 前必須存在)
if [[ ! -f secrets/google-service-account.json ]]; then
  echo '{}' > secrets/google-service-account.json
  ok "建立 secrets/google-service-account.json 佔位 (setup 後會被 Web 上傳覆寫)"
fi

# .env for docker-compose
if [[ ! -f .env ]]; then
  cat > .env <<EOF
# Docker compose 部署層配置
WEB_PORT=$WEB_PORT
EOF
  ok "建立 .env (WEB_PORT=$WEB_PORT)"
fi

# ─── 4. Docker build + up ──────────────────────────
log "docker compose up (build + start)..."
docker compose up -d --build

# ─── 5. 等 container healthy ───────────────────────
log "等 container healthy..."
for i in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' tg-monitor-multi 2>/dev/null || echo "none")
  if [[ "$status" == "healthy" ]]; then
    ok "container healthy (${i}s)"
    break
  fi
  if [[ "$status" == "unhealthy" ]]; then
    err "container unhealthy, 看 log: docker compose logs"
    exit 4
  fi
  sleep 1
  [[ $i -eq 60 ]] && {
    warn "等了 60s 還沒 healthy, 看 log 排查: docker compose logs"
  }
done

# ─── 6. 完成 ───────────────────────────────────────
VERSION=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "?")
VPS_IP=$(curl -fsSL --max-time 3 https://ipinfo.io/ip 2>/dev/null \
         || hostname -I 2>/dev/null | awk '{print $1}' \
         || echo "YOUR_VPS_IP")

echo ""
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo -e "${c_green}${c_bold}  ✓ 安裝完成 · v$VERSION${c_reset}"
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo ""
echo "下一步:"
echo ""
echo -e "  開瀏覽器: ${c_cyan}${c_bold}http://$VPS_IP:$WEB_PORT/setup${c_reset}"
echo "  走 Setup Wizard:"
echo "     1) 填 Web 管理員帳密"
echo "     2) 填 TG API ID / HASH (從 my.telegram.org/apps 取得)"
echo "     3) 上傳 google-service-account.json"
echo "     4) 建立第一個部門"
echo ""
echo "  接著到 /depts/<name>/login 做 TG 登入 (手機 → 驗證碼 → 2FA)"
echo ""
echo -e "${c_bold}常用指令${c_reset}"
echo -e "  看狀態:     ${c_cyan}cd $INSTALL_DIR && docker compose ps${c_reset}"
echo -e "  看實時 log: ${c_cyan}docker compose logs -f${c_reset}"
echo -e "  重啟:       ${c_cyan}docker compose restart${c_reset}"
echo -e "  停止:       ${c_cyan}docker compose down${c_reset}"
echo -e "  升級新版:   ${c_cyan}bash scripts/update.sh${c_reset}"
echo -e "  回滾:       ${c_cyan}bash scripts/rollback.sh${c_reset}"
echo ""
echo -e "${c_bold}安全${c_reset}"
echo -e "  ${c_yellow}⚠${c_reset} port $WEB_PORT 建議只對內網開放 (防火牆擋公網)"
echo -e "  ${c_yellow}⚠${c_reset} 公網訪問建議用 Cloudflare Tunnel 或 Caddy + HTTPS"
echo -e "  ${c_yellow}⚠${c_reset} depts/*/session.txt 是 TG 登入憑證, 建議另存加密備份"
echo ""
