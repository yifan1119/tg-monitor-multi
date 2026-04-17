#!/usr/bin/env bash
# install.sh — 一键部署 (Docker 模式, 主推)
#
# 裸跑模式: 见 install-bare.sh (进阶 / 开发者用)
#
# 用法 (干净 Ubuntu / Debian):
#   curl -fsSL https://raw.githubusercontent.com/yifan1119/tg-monitor-multi/main/install.sh | bash
#
#   # 可配置:
#   INSTALL_DIR=/opt/tg-monitor-multi \
#   REPO_URL=https://github.com/yifan1119/tg-monitor-multi.git \
#   BRANCH=main \
#   WEB_PORT=5003 \
#   bash install.sh
#
# 做什么:
#   1. 装 Docker (若未装)
#   2. git clone repo
#   3. 初始化 secrets/ 和 .env
#   4. docker compose up -d --build
#   5. 等 container healthy
#   6. 印出 Web 设置向导网址

set -euo pipefail

# 防 cwd 失效: 若用户刚 rm -rf 掉当前目录再跑 install, getcwd 会炸
# 强制切到存在的目录 (git clone / docker 都依赖有效 cwd)
cd /tmp 2>/dev/null || cd / || true

INSTALL_DIR="${INSTALL_DIR:-/opt/tg-monitor-multi}"
REPO_URL="${REPO_URL:-https://github.com/yifan1119/tg-monitor-multi.git}"
BRANCH="${BRANCH:-main}"
WEB_PORT="${WEB_PORT:-5003}"
WEB_PORT_AUTO="${WEB_PORT_AUTO:-1}"   # 1=端口被占自动往上找; 0=强制用 WEB_PORT

# 回传 0=被占, 1=空闲
port_in_use() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>/dev/tcp/127.0.0.1/"$p") >/dev/null 2>&1
  fi
}

pick_free_port() {
  local p="$1"
  for _ in $(seq 1 50); do
    port_in_use "$p" || { echo "$p"; return 0; }
    p=$((p + 1))
  done
  return 1
}

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
  warn "建议用 root 或 sudo 跑 (装 Docker 需要)"
fi

# ─── 必备工具 ──────────────────────────────────────
for cmd in git curl; do
  if ! command -v "$cmd" >/dev/null; then
    err "$cmd 未装. 请先: apt-get install -y $cmd  或  yum install -y $cmd"
    exit 1
  fi
done

# ─── 1. 装 Docker ──────────────────────────────────
if ! command -v docker >/dev/null; then
  log "装 Docker (透过 get.docker.com)..."
  curl -fsSL https://get.docker.com | sh
  ok "Docker 已装"
else
  ok "Docker 已存在: $(docker -v)"
fi

# 确认 docker compose plugin
if ! docker compose version >/dev/null 2>&1; then
  err "docker compose v2 plugin 不可用."
  err "  Linux: Docker 20.10+ 内建; 若没有, 另装: apt-get install -y docker-compose-plugin"
  exit 2
fi
ok "docker compose: $(docker compose version --short)"

# 确认 Docker daemon 跑着
if ! docker info >/dev/null 2>&1; then
  log "Docker daemon 未跑, 启动..."
  systemctl start docker 2>/dev/null || service docker start 2>/dev/null || {
    err "无法启动 Docker. 手动: systemctl start docker"
    exit 3
  }
fi

# ─── 2. git clone ──────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  warn "$INSTALL_DIR 已有 repo, git pull 拉最新"
  (cd "$INSTALL_DIR" && git pull --ff-only)
else
  if [[ -d "$INSTALL_DIR" ]] && [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]]; then
    err "$INSTALL_DIR 非空且非 git repo, 无法 clone. 清空或换目录 (INSTALL_DIR=...)"
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

# google-service-account.json 占位档 (bind mount 前必须存在)
if [[ ! -f secrets/google-service-account.json ]]; then
  echo '{}' > secrets/google-service-account.json
  ok "建立 secrets/google-service-account.json 占位 (setup 后会被 Web 上传覆写)"
fi

# 先停掉自己的旧容器, 避免它占着端口干扰下面检测
if docker ps --format '{{.Names}}' | grep -qx tg-monitor-multi; then
  log "停掉旧的 tg-monitor-multi 容器 (避免端口冲突检测误判)"
  docker compose down >/dev/null 2>&1 || docker stop tg-monitor-multi >/dev/null 2>&1 || true
fi

# 端口检测: 被占就自动往上找 (除非 WEB_PORT_AUTO=0)
if port_in_use "$WEB_PORT"; then
  if [[ "$WEB_PORT_AUTO" == "1" ]]; then
    warn "port $WEB_PORT 被占, 自动找空闲端口..."
    if ! NEW_PORT=$(pick_free_port $((WEB_PORT + 1))); then
      err "连找 50 个都被占, 放弃. 请用 WEB_PORT=xxxx 指定"
      exit 5
    fi
    ok "改用 port $NEW_PORT (原 $WEB_PORT 被占)"
    WEB_PORT="$NEW_PORT"
  else
    err "port $WEB_PORT 被占且 WEB_PORT_AUTO=0. 换端口或停掉占用进程"
    exit 5
  fi
else
  ok "port $WEB_PORT 空闲"
fi

# .env for docker-compose (每次覆写, 保证和上面检测到的 port 一致)
cat > .env <<EOF
# Docker compose 部署层配置 (install.sh 自动写, 手改会被下次 install 覆盖)
WEB_PORT=$WEB_PORT
EOF
ok "写入 .env (WEB_PORT=$WEB_PORT)"

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
    warn "等了 60s 还没 healthy, 看 log 排查: docker compose logs"
  }
done

# ─── 6. 完成 ───────────────────────────────────────
VERSION=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo "?")
VPS_IP=$(curl -fsSL --max-time 3 https://ipinfo.io/ip 2>/dev/null \
         || hostname -I 2>/dev/null | awk '{print $1}' \
         || echo "YOUR_VPS_IP")

echo ""
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo -e "${c_green}${c_bold}  ✓ 安装完成 · v$VERSION${c_reset}"
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo ""
echo "下一步:"
echo ""
echo -e "  开浏览器: ${c_cyan}${c_bold}http://$VPS_IP:$WEB_PORT/setup${c_reset}"
echo "  走 Setup Wizard:"
echo "     1) 填 Web 管理员帐密"
echo "     2) 填 TG API ID / HASH (从 my.telegram.org/apps 取得)"
echo "     3) 上传 google-service-account.json"
echo "     4) 建立第一个部门"
echo ""
echo "  接着到 /depts/<name>/login 做 TG 登入 (手机 → 验证码 → 2FA)"
echo ""
echo -e "${c_bold}常用指令${c_reset}"
echo -e "  看状态:     ${c_cyan}cd $INSTALL_DIR && docker compose ps${c_reset}"
echo -e "  看实时 log: ${c_cyan}docker compose logs -f${c_reset}"
echo -e "  重启:       ${c_cyan}docker compose restart${c_reset}"
echo -e "  停止:       ${c_cyan}docker compose down${c_reset}"
echo -e "  升级新版:   ${c_cyan}bash scripts/update.sh${c_reset}"
echo -e "  回滚:       ${c_cyan}bash scripts/rollback.sh${c_reset}"
echo ""
echo -e "${c_bold}安全${c_reset}"
echo -e "  ${c_yellow}⚠${c_reset} port $WEB_PORT 建议只对内网开放 (防火墙挡公网)"
echo -e "  ${c_yellow}⚠${c_reset} 公网访问建议用 Cloudflare Tunnel 或 Caddy + HTTPS"
echo -e "  ${c_yellow}⚠${c_reset} depts/*/session.txt 是 TG 登入凭证, 建议另存加密备份"
echo ""
