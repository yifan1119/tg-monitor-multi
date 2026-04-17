#!/usr/bin/env bash
# update.sh — 从 git 拉新版并重启. 自动侦测 Docker / 裸跑模式.
#
# 流程 (两种模式共通):
#   1. 记录当前 commit + 版号
#   2. 备份 depts/ + data/ + global/ + secrets/ 到 .backups/<timestamp>/
#   3. git fetch + pull --ff-only
#   4. 按模式重启:
#      - Docker:  docker compose up -d --build
#      - 裸跑:    npm ci + pm2 reload ecosystem.config.js
#
# R1-R7 契约保证:
#   - session.txt / .env / google-service-account.json 永不被脚本改动
#   - event_history.jsonl / state/ 永不被清空
#   - 用户自订的 config.json 保留 (新字段由代码 default 处理)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$ROOT/.backups/$TS"
LOG="$BACKUP_DIR/update.log"

cd "$ROOT"

# ─── 侦测部署模式 ──────────────────────────────────
detect_mode() {
  if [[ -f "$ROOT/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1; then
    # compose file 存在 + docker 可用 → 检查 container 是否跑过
    if docker compose ps --services 2>/dev/null | grep -q "tg-monitor"; then
      echo "docker"
      return
    fi
    # 有 compose file 但 container 没跑 (首次装或下线中)
    # 问: 要不要走 Docker? 由环境变数决定, 预设 docker (因 compose file 在就表示该走 docker)
    echo "docker"
    return
  fi
  echo "bare"
}

MODE="${UPDATE_MODE:-$(detect_mode)}"

# ─── 预检 ──────────────────────────────────────────
command -v git >/dev/null || { echo "✗ git 未安装"; exit 1; }
[[ -d "$ROOT/.git" ]] || { echo "✗ 不是 git repo: $ROOT"; exit 1; }

if [[ "$MODE" == "docker" ]]; then
  command -v docker >/dev/null || { echo "✗ Docker 未装 (UPDATE_MODE=docker)"; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "✗ docker compose plugin 不可用"; exit 1; }
else
  command -v node >/dev/null || { echo "✗ node 未装 (UPDATE_MODE=bare)"; exit 1; }
  command -v npm  >/dev/null || { echo "✗ npm 未装";  exit 1; }
fi

# ─── 1. 记录当前版本 ──────────────────────────────
OLD_COMMIT="$(git rev-parse HEAD)"
OLD_VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo 'unknown')"

mkdir -p "$BACKUP_DIR"
exec > >(tee -a "$LOG") 2>&1

echo "═══════════════════════════════════════════════════"
echo "  tg-monitor-multi update · $TS · [$MODE mode]"
echo "═══════════════════════════════════════════════════"
echo "  当前版本:  $OLD_VERSION"
echo "  当前 commit: $OLD_COMMIT"
echo ""

# ─── 2. 备份 ───────────────────────────────────────
echo "▸ 备份 depts/ + data/ + global/ + secrets/ → $BACKUP_DIR"
[[ -d "$ROOT/depts"   ]] && cp -r "$ROOT/depts"   "$BACKUP_DIR/depts"
[[ -d "$ROOT/data"    ]] && cp -r "$ROOT/data"    "$BACKUP_DIR/data"
[[ -d "$ROOT/global"  ]] && cp -r "$ROOT/global"  "$BACKUP_DIR/global"
[[ -d "$ROOT/secrets" ]] && cp -r "$ROOT/secrets" "$BACKUP_DIR/secrets"

echo "$OLD_COMMIT"  > "$BACKUP_DIR/commit"
echo "$OLD_VERSION" > "$BACKUP_DIR/version"
echo "$TS"          > "$BACKUP_DIR/timestamp"
echo "$MODE"        > "$BACKUP_DIR/mode"
echo "  ✓ 备份完成"
echo ""

# ─── 3. git pull ───────────────────────────────────
echo "▸ 拉取新版 (git pull --ff-only)..."
git fetch origin
if ! git pull --ff-only; then
  echo ""
  echo "✗ git pull --ff-only 失败 (有冲突 / 本地未 commit 改动)"
  echo "  本地代码没变, 备份仍在. 修正后重跑."
  exit 2
fi

NEW_COMMIT="$(git rev-parse HEAD)"
NEW_VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo 'unknown')"

if [[ "$OLD_COMMIT" == "$NEW_COMMIT" ]]; then
  echo "  ✓ 已是最新版, 没有变化"
  echo "  (备份仍会保留, 可用 clean-backups.sh 清理)"
  exit 0
fi

echo "  $OLD_VERSION ($OLD_COMMIT) → $NEW_VERSION ($NEW_COMMIT)"
echo ""

# ─── 4a. Docker 模式: compose up --build ──────────
if [[ "$MODE" == "docker" ]]; then
  echo "▸ docker compose up -d --build (rebuild + rolling restart)..."
  docker compose up -d --build

  echo "▸ 等 container healthy..."
  for i in $(seq 1 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' tg-monitor-multi 2>/dev/null || echo "starting")
    if [[ "$status" == "healthy" ]]; then
      echo "  ✓ healthy (${i}s)"
      break
    fi
    if [[ "$status" == "unhealthy" ]]; then
      echo "  ✗ unhealthy — 看 log: docker compose logs"
      echo "  考虑回滚: bash scripts/rollback.sh $BACKUP_DIR"
      exit 3
    fi
    sleep 1
  done

# ─── 4b. 裸跑模式: npm ci + pm2 reload ────────────
else
  echo "▸ 更新依赖 (npm ci)..."
  (cd "$ROOT" && npm ci --silent) || (cd "$ROOT/shared" && npm ci --silent && cd "$ROOT/web" && npm ci --silent)

  echo "▸ 重生 ecosystem.config.js..."
  node "$ROOT/scripts/generate-ecosystem.js"

  if command -v pm2 >/dev/null; then
    echo "▸ pm2 reload..."
    if [[ -f "$ROOT/ecosystem.config.js" ]]; then
      pm2 reload "$ROOT/ecosystem.config.js" 2>/dev/null || pm2 start "$ROOT/ecosystem.config.js"
      pm2 save >/dev/null
    else
      echo "  (ecosystem.config.js 不存在, 跳过 — 尚无部门)"
    fi
  else
    echo "⚠ pm2 未安装, 跳过重启. 手动处理."
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ 升级完成: $OLD_VERSION → $NEW_VERSION  [$MODE]"
echo "═══════════════════════════════════════════════════"
echo ""
echo "备份: $BACKUP_DIR"
echo ""
echo "若此次升级有问题, 回滚:"
echo "  bash $ROOT/scripts/rollback.sh $BACKUP_DIR"
echo ""
echo "列出所有备份: bash $ROOT/scripts/list-backups.sh"
