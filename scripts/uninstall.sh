#!/usr/bin/env bash
# uninstall.sh — 干净卸载 tg-monitor-multi (某个实例)
#
# 默认保留敏感数据 (depts/ data/ secrets/), 加 --purge 才彻底删.
#
# 用法:
#   bash scripts/uninstall.sh                # 卸载当前目录对应的实例
#   bash scripts/uninstall.sh ivan           # 指定实例名
#   bash scripts/uninstall.sh ivan --purge   # 连数据一起删 (!!!)
#   bash scripts/uninstall.sh --force        # 跳过确认提示
#
# 做什么:
#   1. 识别 INSTANCE (位置参数 / env / .env)
#   2. 停容器 (docker compose down)
#   3. 删镜像 (tg-monitor-multi[-INSTANCE]:local)
#   4. 如果跑了 HTTPS 接入模式, 从外部 Caddy 的 Caddyfile 删对应 site block + reload
#   5. 删安装目录 (--purge 模式: 全删; 默认模式: 只删代码 + node_modules, 保留数据)
#
# 保留哪些 (默认模式):
#   depts/       — TG session / config
#   data/        — 系统配置 / 管理员
#   secrets/     — Google SA
#   .backups/    — 升级备份
#   → 都 mv 到 /root/tg-monitor-backup-<instance>-<ts>/ 免得卸载后误操作

# 改用显式错误处理 (不 set -e, 避免单个命令失败就静默退出).
# 只保留 set -u (未定义变量 error).
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
if [[ -z "$SCRIPT_DIR" ]]; then
  echo "✗ 找不到脚本目录" >&2; exit 1
fi
cd "$SCRIPT_DIR/.." || { echo "✗ cd 失败: $SCRIPT_DIR/.." >&2; exit 1; }

echo ">>> uninstall.sh 启动, 工作目录: $(pwd)"

c_green='\033[0;32m'; c_yellow='\033[0;33m'; c_red='\033[0;31m'
c_cyan='\033[0;36m'; c_bold='\033[1m'; c_reset='\033[0m'

log()  { echo -e "${c_cyan}▸${c_reset} $*"; }
ok()   { echo -e "${c_green}✓${c_reset} $*"; }
warn() { echo -e "${c_yellow}⚠${c_reset} $*"; }
err()  { echo -e "${c_red}✗${c_reset} $*" >&2; }

# ─── 参数 ──────────────────────────────────────────
PURGE=0
FORCE=0
INSTANCE_ARG=""
for arg in "$@"; do
  case "$arg" in
    --purge|--all) PURGE=1 ;;
    --force|-y) FORCE=1 ;;
    --*) warn "未知参数: $arg (忽略)" ;;
    *)
      if [[ -z "$INSTANCE_ARG" ]]; then
        INSTANCE_ARG="$arg"
      fi
      ;;
  esac
done

# ─── 识别 INSTANCE ─────────────────────────────────
INSTANCE="${INSTANCE_ARG:-${INSTANCE:-}}"
if [[ -z "$INSTANCE" ]] && [[ -f .env ]]; then
  INSTANCE=$(grep "^INSTANCE=" .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]')
fi
if [[ -n "$INSTANCE" ]]; then INSTANCE_SUFFIX="-$INSTANCE"; else INSTANCE_SUFFIX=""; fi

WEB_CONTAINER="tg-monitor-multi${INSTANCE_SUFFIX}"
OWN_CADDY="tg-monitor-multi-caddy${INSTANCE_SUFFIX}"
IMAGE="tg-monitor-multi${INSTANCE_SUFFIX}:local"
INSTALL_DIR="$(pwd)"
SELF_TAG="tg-monitor-multi${INSTANCE_SUFFIX}"
TS=$(date +%Y%m%d-%H%M%S)

# ─── 二次确认 ──────────────────────────────────────
echo -e "${c_bold}"
echo "═══════════════════════════════════════════════════"
echo "  tg-monitor-multi · 卸载"
echo "═══════════════════════════════════════════════════"
echo -e "${c_reset}"
echo "  实例:        ${INSTANCE:-默认}"
echo "  安装目录:    $INSTALL_DIR"
echo "  容器:        $WEB_CONTAINER"
echo "  镜像:        $IMAGE"
echo "  模式:        $([[ $PURGE -eq 1 ]] && echo -e "${c_red}PURGE (连数据一起删, 不可逆!)${c_reset}" || echo '保留数据 (会 mv 到 /root/ 下备份)')"
echo ""

if [[ "$FORCE" -ne 1 ]]; then
  read -p "确认卸载? 输入 YES 继续: " confirm
  if [[ "$confirm" != "YES" ]]; then
    echo "取消."
    exit 0
  fi
fi

# ─── 1. 停容器 + 删镜像 ────────────────────────────
log "停止容器..."
docker compose --profile https down 2>/dev/null || docker compose down 2>/dev/null || true
# 保底: 如果 compose 识别不了 (目录 rename 等), 直接按名字杀
docker rm -f "$WEB_CONTAINER" 2>/dev/null || true
docker rm -f "$OWN_CADDY" 2>/dev/null || true
ok "容器已停"

log "删镜像 $IMAGE..."
docker rmi -f "$IMAGE" 2>/dev/null || warn "镜像不存在或删失败 (可能已删)"

# ─── 2. 清理外部 Caddy 里的 site block ─────────────
log "扫外部 Caddy, 看有没有本项目的 site block..."
found_ext_caddy=0
for cname in $(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE "caddy" | grep -v "$OWN_CADDY" || true); do
  image=$(docker inspect "$cname" --format '{{.Config.Image}}' 2>/dev/null || echo "")
  echo "$image" | grep -qi caddy || continue

  caddyfile_host=$(docker inspect "$cname" \
    --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || echo "")
  [[ -z "$caddyfile_host" ]] && continue

  if grep -q "$SELF_TAG" "$caddyfile_host" 2>/dev/null; then
    log "发现 $cname 的 Caddyfile ($caddyfile_host) 含本项目 site block, 清除..."
    # 删从 "=== SELF_TAG — auto-added ===" 到 "=== end SELF_TAG ===" 的整段.
    # 注意 start 行有附加文字 "— auto-added by ...", 不能用完全匹配.
    tmp=$(mktemp)
    awk -v tag="$SELF_TAG" '
      BEGIN { skip = 0 }
      {
        # end 行严格: "=== end <tag> ==="
        if (index($0, "=== end " tag " ===") > 0) { skip = 0; next }
        if (skip) next
        # start 行: "=== <tag> " (带 trailing 空格避免前缀撞 tg-monitor-multi-ivan)
        if (index($0, "=== " tag " ") > 0) { skip = 1; next }
        print
      }
    ' "$caddyfile_host" > "$tmp"
    mv "$tmp" "$caddyfile_host"

    log "reload $cname..."
    docker exec "$cname" caddy reload --config /etc/caddy/Caddyfile 2>/dev/null \
      || docker exec "$cname" caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile 2>/dev/null \
      || docker restart "$cname" >/dev/null 2>&1 \
      || warn "reload 失败, 手动处理: docker restart $cname"
    ok "已清除"
    found_ext_caddy=1
  fi
done
[[ $found_ext_caddy -eq 0 ]] && log "(没有发现外部 Caddy 里的本项目配置, 跳过)"

# ─── 3. 删数据 or 备份 ─────────────────────────────
PARENT_DIR=$(dirname "$INSTALL_DIR")

if [[ "$PURGE" -eq 1 ]]; then
  warn "PURGE 模式: 5 秒后彻底删 $INSTALL_DIR ..."
  sleep 5
  cd /
  rm -rf "$INSTALL_DIR"
  ok "已删 $INSTALL_DIR"
else
  BACKUP_DIR="/root/tg-monitor-backup${INSTANCE_SUFFIX}-${TS}"
  log "保留数据 → 备份到 $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"

  for d in depts data secrets global .backups .healthcheck; do
    if [[ -d "$INSTALL_DIR/$d" ]] && [[ -n "$(ls -A "$INSTALL_DIR/$d" 2>/dev/null)" ]]; then
      mv "$INSTALL_DIR/$d" "$BACKUP_DIR/$d" && log "  → $d"
    fi
  done

  # .env 也备份 (有 TG_API_ID / HASH)
  [[ -f "$INSTALL_DIR/.env" ]] && cp "$INSTALL_DIR/.env" "$BACKUP_DIR/.env"

  # 其他 (代码 / node_modules / docker-compose 等) 删了
  cd /
  rm -rf "$INSTALL_DIR"
  ok "已删代码, 数据保留在 $BACKUP_DIR"
fi

echo ""
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo -e "${c_green}${c_bold}  ✓ 卸载完成${c_reset}"
echo -e "${c_bold}═══════════════════════════════════════════════════${c_reset}"
echo ""
if [[ "$PURGE" -ne 1 ]]; then
  echo "  数据备份: ${c_cyan}$BACKUP_DIR${c_reset}"
  echo "  不需要了就: rm -rf $BACKUP_DIR"
fi
echo ""
