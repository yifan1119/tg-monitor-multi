#!/usr/bin/env bash
# enable-https.sh — 给 tg-monitor-multi Web 一键启用 HTTPS
#
# 用法:
#   bash scripts/enable-https.sh                  # 自动用 nip.io (无需域名)
#   bash scripts/enable-https.sh mysite.com       # 用自己的域名 (先把 A 记录指过来)
#
# 做什么:
#   1. 决定 PUBLIC_DOMAIN (nip.io 或你给的)
#   2. 写入 .env
#   3. docker compose --profile https up -d caddy
#   4. Caddy 自动申请 Let's Encrypt 证书 (80 端口必须能通)
#
# 停用 HTTPS:
#   docker compose --profile https down caddy
#   从 .env 删掉 PUBLIC_DOMAIN (可选)

set -euo pipefail

cd "$(dirname "$0")/.."

c_green='\033[0;32m'; c_yellow='\033[0;33m'; c_red='\033[0;31m'
c_cyan='\033[0;36m'; c_bold='\033[1m'; c_reset='\033[0m'

log()  { echo -e "${c_cyan}▸${c_reset} $*"; }
ok()   { echo -e "${c_green}✓${c_reset} $*"; }
warn() { echo -e "${c_yellow}⚠${c_reset} $*"; }
err()  { echo -e "${c_red}✗${c_reset} $*" >&2; }

echo -e "${c_bold}"
echo "═══════════════════════════════════════════════════"
echo "  tg-monitor-multi · 启用 HTTPS"
echo "═══════════════════════════════════════════════════"
echo -e "${c_reset}"

# ─── 1. 决定域名 ───────────────────────────────────
if [[ -n "${1:-}" ]]; then
  DOMAIN="$1"
  log "使用自定义域名: $DOMAIN"
  warn "请确认 $DOMAIN 的 DNS A 记录已指向本机 IP"
else
  IP=$(curl -fsSL --max-time 5 https://ipinfo.io/ip 2>/dev/null \
       || curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null \
       || echo "")
  if [[ -z "$IP" ]]; then
    err "取不到公网 IP. 请手动指定域名: bash scripts/enable-https.sh your-domain.com"
    exit 1
  fi
  # nip.io 支持两种格式: 1.2.3.4.nip.io 和 1-2-3-4.nip.io. 带点的更直观
  DOMAIN="${IP}.nip.io"
  ok "自动用 nip.io: $DOMAIN (会解析到 $IP)"
fi

# ─── 2. 检查 80/443 端口 ───────────────────────────
log "检查 80/443 端口是否空闲..."
for port in 80 443; do
  # 排除我们自己的 caddy 容器
  occupier=$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null \
             | awk -F'|' -v p=":${port}->" '$2 ~ p {print $1}' \
             | grep -v "tg-monitor-multi-caddy" || true)
  if [[ -n "$occupier" ]]; then
    err "端口 $port 被占: $occupier"
    err "  请先停掉它 (docker stop $occupier), 或者让它反代到 $DOMAIN 自行处理"
    exit 2
  fi

  # 非 docker 占用 (nginx / apache / systemd-caddy 等)
  if command -v ss >/dev/null 2>&1; then
    sys_occ=$(ss -tlnp 2>/dev/null | awk -v p=":${port}$" '$4 ~ p {print $NF}' | head -1 || true)
    if [[ -n "$sys_occ" ]]; then
      err "端口 $port 被宿主机进程占用: $sys_occ"
      err "  请先停掉 (systemctl stop ... 或 kill)"
      exit 2
    fi
  fi
done
ok "80 / 443 空闲"

# ─── 3. 写入 .env ──────────────────────────────────
if grep -q "^PUBLIC_DOMAIN=" .env 2>/dev/null; then
  # macOS / Linux sed 兼容 — 用临时文件绕开 -i 差异
  grep -v "^PUBLIC_DOMAIN=" .env > .env.tmp
  echo "PUBLIC_DOMAIN=$DOMAIN" >> .env.tmp
  mv .env.tmp .env
else
  echo "PUBLIC_DOMAIN=$DOMAIN" >> .env
fi
ok ".env 已更新 (PUBLIC_DOMAIN=$DOMAIN)"

# ─── 4. 拉起 Caddy ─────────────────────────────────
log "启动 Caddy 反代..."
docker compose --profile https up -d caddy

# ─── 5. 等证书 ─────────────────────────────────────
log "等 Caddy 申请证书 (Let's Encrypt, 30-60s)..."
for i in $(seq 1 60); do
  if curl -fsS --max-time 3 -o /dev/null "https://${DOMAIN}/" 2>/dev/null; then
    ok "HTTPS 可用 (${i}s)"
    break
  fi
  sleep 1
  [[ $i -eq 60 ]] && warn "60s 内还没申请到证书. 看 log 排查: docker compose logs caddy"
done

echo ""
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo -e "${c_green}${c_bold}  ✓ HTTPS 已启用${c_reset}"
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo ""
echo -e "  新地址: ${c_cyan}${c_bold}https://${DOMAIN}/${c_reset}"
echo ""
echo "  原 HTTP 端口 (5003) 还在, 但以后对外就用 HTTPS 就好"
echo ""
echo "常用指令"
echo -e "  看 Caddy log:  ${c_cyan}docker compose logs caddy${c_reset}"
echo -e "  看证书状态:    ${c_cyan}docker exec tg-monitor-multi-caddy caddy list-certificates${c_reset}"
echo -e "  停 HTTPS:      ${c_cyan}docker compose --profile https down caddy${c_reset}"
echo ""
