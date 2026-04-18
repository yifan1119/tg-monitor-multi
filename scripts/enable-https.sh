#!/usr/bin/env bash
# enable-https.sh — 给 tg-monitor-multi Web 一键启用 HTTPS
#
# 智能 3 种模式:
#   1. 80/443 空闲        → 拉起自建 Caddy 容器 (docker compose --profile https)
#   2. 80/443 被 Caddy 占  → 接入模式: 我们加一段到它的 Caddyfile + reload (不抢端口)
#   3. 80/443 被非 Caddy 占 → 报错, 打印操作指南
#
# 用法:
#   bash scripts/enable-https.sh                 # 自动 nip.io (无需域名)
#   bash scripts/enable-https.sh your-domain.com # 用自己的域名 (先 A 记录)

set -euo pipefail

cd "$(dirname "$0")/.."

c_green='\033[0;32m'; c_yellow='\033[0;33m'; c_red='\033[0;31m'
c_cyan='\033[0;36m'; c_bold='\033[1m'; c_reset='\033[0m'

log()  { echo -e "${c_cyan}▸${c_reset} $*"; }
ok()   { echo -e "${c_green}✓${c_reset} $*"; }
warn() { echo -e "${c_yellow}⚠${c_reset} $*"; }
err()  { echo -e "${c_red}✗${c_reset} $*" >&2; }

OWN_CADDY="tg-monitor-multi-caddy"
WEB_CONTAINER="tg-monitor-multi"
WEB_PORT_IN_CONTAINER=5003
SELF_TAG="tg-monitor-multi"

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
  DOMAIN="${IP}.nip.io"
  ok "自动用 nip.io: $DOMAIN (会解析到 $IP)"
fi

# ─── 2. 检查 80/443 占用情况 ───────────────────────
log "检查 80/443 占用..."
EXTERNAL_CADDY=""
NON_CADDY_OCCUPIER=""

for port in 80 443; do
  occupier=$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null \
             | awk -F'|' -v p=":${port}->" '$2 ~ p {print $1; exit}' || true)
  if [[ -n "$occupier" ]]; then
    # 是自己就跳过
    [[ "$occupier" == "$OWN_CADDY" ]] && continue

    image=$(docker inspect "$occupier" --format '{{.Config.Image}}' 2>/dev/null || echo "")
    if echo "$image" | grep -qi caddy; then
      EXTERNAL_CADDY="$occupier"
      log "端口 $port 被现成 Caddy 占: $occupier ($image)"
      break
    else
      NON_CADDY_OCCUPIER="$occupier ($image)"
      break
    fi
  fi

  # 非 docker 占用 (宿主机 nginx / systemd-caddy)
  if command -v ss >/dev/null 2>&1; then
    sys_occ=$(ss -tlnp 2>/dev/null | awk -v p=":${port}$" '$4 ~ p {print $NF}' | head -1 || true)
    if [[ -n "$sys_occ" ]]; then
      NON_CADDY_OCCUPIER="$sys_occ (宿主机进程)"
      break
    fi
  fi
done

if [[ -n "$NON_CADDY_OCCUPIER" ]]; then
  err "端口被非 Caddy 进程占: $NON_CADDY_OCCUPIER"
  err "  没办法自动接管. 请先停掉它 (docker stop / systemctl stop), 再跑本脚本"
  exit 2
fi

# ─── 3. 写入 .env (PUBLIC_DOMAIN) ───────────────────
if grep -q "^PUBLIC_DOMAIN=" .env 2>/dev/null; then
  grep -v "^PUBLIC_DOMAIN=" .env > .env.tmp
  echo "PUBLIC_DOMAIN=$DOMAIN" >> .env.tmp
  mv .env.tmp .env
else
  echo "PUBLIC_DOMAIN=$DOMAIN" >> .env
fi
ok ".env 已更新 (PUBLIC_DOMAIN=$DOMAIN)"

# ─── 4a. 模式: 80/443 空闲 → 拉起自建 Caddy ─────────
if [[ -z "$EXTERNAL_CADDY" ]]; then
  log "80/443 空闲, 启动自建 Caddy..."
  docker compose --profile https up -d caddy

  log "等 Caddy 申请证书 (Let's Encrypt, 30-60s)..."
  for i in $(seq 1 60); do
    if curl -fsS --max-time 3 -o /dev/null "https://${DOMAIN}/" 2>/dev/null; then
      ok "HTTPS 可用 (${i}s)"
      break
    fi
    sleep 1
    [[ $i -eq 60 ]] && warn "60s 内还没拿到证书. 排查: docker compose logs caddy"
  done
  MODE="自建 Caddy"

# ─── 4b. 模式: 现成 Caddy 占着 → 接入模式 ───────────
else
  log "切「外部反代」模式 — 共享现成 Caddy ($EXTERNAL_CADDY)"

  # 确保 web 容器在跑 (不启 --profile https)
  if ! docker ps --format '{{.Names}}' | grep -qx "$WEB_CONTAINER"; then
    log "web 容器没起, 拉起..."
    docker compose up -d
    sleep 2
  fi

  # 4b-1. 找外部 Caddy 的 docker network (非 bridge)
  EXT_NET=$(docker inspect "$EXTERNAL_CADDY" \
    --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' \
    2>/dev/null | grep -v '^$' | grep -v '^bridge$' | head -1)
  [[ -z "$EXT_NET" ]] && EXT_NET=$(docker inspect "$EXTERNAL_CADDY" \
    --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' \
    2>/dev/null | grep -v '^$' | head -1)

  UPSTREAM=""
  if [[ -n "$EXT_NET" ]]; then
    log "把 $WEB_CONTAINER 接入 Caddy network: $EXT_NET"
    docker network connect "$EXT_NET" "$WEB_CONTAINER" 2>/dev/null || true
    if docker inspect "$WEB_CONTAINER" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | grep -q "$EXT_NET"; then
      UPSTREAM="${WEB_CONTAINER}:${WEB_PORT_IN_CONTAINER}"
      ok "反代 upstream = container 名: $UPSTREAM"
    fi
  fi

  # fallback: host gateway
  if [[ -z "$UPSTREAM" ]]; then
    WEB_PORT_HOST=$(grep "^WEB_PORT=" .env 2>/dev/null | cut -d= -f2 | head -1)
    WEB_PORT_HOST="${WEB_PORT_HOST:-5003}"
    HOST_GW=$(ip -4 route 2>/dev/null | awk '/default/ {print $3; exit}')
    if [[ -n "$HOST_GW" ]]; then
      UPSTREAM="${HOST_GW}:${WEB_PORT_HOST}"
      warn "network 接不上, fallback: $UPSTREAM"
    else
      UPSTREAM="host.docker.internal:${WEB_PORT_HOST}"
      warn "network 接不上, fallback: $UPSTREAM"
    fi
  fi

  # 4b-2. 找外部 Caddyfile 宿主机路径
  EXT_CADDYFILE=$(docker inspect "$EXTERNAL_CADDY" \
    --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' \
    2>/dev/null || echo "")

  SITE_BLOCK=$(cat <<EOF

# === ${SELF_TAG} — auto-added by enable-https.sh ===
${DOMAIN} {
    reverse_proxy ${UPSTREAM} {
        header_up Host {host}
        header_up X-Real-IP {remote}
        header_up X-Forwarded-For {remote}
        header_up X-Forwarded-Proto {scheme}
    }
    encode gzip
}
# === end ${SELF_TAG} ===
EOF
)

  if [[ -n "$EXT_CADDYFILE" && -f "$EXT_CADDYFILE" ]]; then
    if grep -q "${SELF_TAG}" "$EXT_CADDYFILE"; then
      ok "$EXT_CADDYFILE 已有本项目 block, 跳过追加"
    else
      log "追加 site block 到 $EXT_CADDYFILE"
      echo "$SITE_BLOCK" >> "$EXT_CADDYFILE"
    fi

    log "Caddy reload..."
    if docker exec "$EXTERNAL_CADDY" caddy reload --config /etc/caddy/Caddyfile 2>/dev/null; then
      ok "reload 成功"
    elif docker exec "$EXTERNAL_CADDY" caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile 2>/dev/null; then
      ok "reload 成功 (caddyfile adapter)"
    else
      warn "reload 失败, 用 restart 兜底..."
      docker restart "$EXTERNAL_CADDY" >/dev/null 2>&1 && ok "Caddy 已重启" || err "Caddy 重启也失败"
    fi

    log "等 Let's Encrypt 签证 (最多 60s)..."
    for i in $(seq 1 12); do
      sleep 5
      if docker logs "$EXTERNAL_CADDY" 2>&1 | tail -100 | grep -qE "certificate obtained|certificate for \[${DOMAIN}\]"; then
        ok "证书 OK"
        break
      fi
      echo "  等中 ($i/12)"
    done
  else
    warn "没找到外部 Caddyfile 的 bind mount (可能用 JSON/API 配置)."
    warn "请手动把下面这段加到你的 Caddy 配置里, 然后 reload:"
    echo ""
    echo "$SITE_BLOCK"
    echo ""
  fi
  MODE="共享外部 Caddy ($EXTERNAL_CADDY)"
fi

# ─── 5. 完成 ───────────────────────────────────────
echo ""
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo -e "${c_green}${c_bold}  ✓ HTTPS 已启用${c_reset}"
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo ""
echo -e "  新地址: ${c_cyan}${c_bold}https://${DOMAIN}/${c_reset}"
echo -e "  模式:   $MODE"
echo ""
echo "  原 HTTP 端口还在, 对外建议只用 HTTPS"
echo ""
echo "常用指令"
if [[ -n "$EXTERNAL_CADDY" ]]; then
  echo -e "  看 Caddy log:  ${c_cyan}docker logs $EXTERNAL_CADDY --tail 50${c_reset}"
  echo -e "  停 HTTPS:      手动编辑 $EXT_CADDYFILE 删掉本项目 block + docker exec $EXTERNAL_CADDY caddy reload"
else
  echo -e "  看 Caddy log:  ${c_cyan}docker compose logs caddy${c_reset}"
  echo -e "  停 HTTPS:      ${c_cyan}docker compose --profile https down caddy${c_reset}"
fi
echo ""
