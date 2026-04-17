#!/usr/bin/env bash
# update.sh — 從 git 拉新版並重啟. 自動偵測 Docker / 裸跑模式.
#
# 流程 (兩種模式共通):
#   1. 記錄當前 commit + 版號
#   2. 備份 depts/ + data/ + global/ + secrets/ 到 .backups/<timestamp>/
#   3. git fetch + pull --ff-only
#   4. 按模式重啟:
#      - Docker:  docker compose up -d --build
#      - 裸跑:    npm ci + pm2 reload ecosystem.config.js
#
# R1-R7 契約保證:
#   - session.txt / .env / google-service-account.json 永不被腳本改動
#   - event_history.jsonl / state/ 永不被清空
#   - 用戶自訂的 config.json 保留 (新欄位由代碼 default 處理)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$ROOT/.backups/$TS"
LOG="$BACKUP_DIR/update.log"

cd "$ROOT"

# ─── 偵測部署模式 ──────────────────────────────────
detect_mode() {
  if [[ -f "$ROOT/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1; then
    # compose file 存在 + docker 可用 → 檢查 container 是否跑過
    if docker compose ps --services 2>/dev/null | grep -q "tg-monitor"; then
      echo "docker"
      return
    fi
    # 有 compose file 但 container 沒跑 (首次裝或下線中)
    # 問: 要不要走 Docker? 由環境變數決定, 預設 docker (因 compose file 在就表示該走 docker)
    echo "docker"
    return
  fi
  echo "bare"
}

MODE="${UPDATE_MODE:-$(detect_mode)}"

# ─── 預檢 ──────────────────────────────────────────
command -v git >/dev/null || { echo "✗ git 未安裝"; exit 1; }
[[ -d "$ROOT/.git" ]] || { echo "✗ 不是 git repo: $ROOT"; exit 1; }

if [[ "$MODE" == "docker" ]]; then
  command -v docker >/dev/null || { echo "✗ Docker 未裝 (UPDATE_MODE=docker)"; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "✗ docker compose plugin 不可用"; exit 1; }
else
  command -v node >/dev/null || { echo "✗ node 未裝 (UPDATE_MODE=bare)"; exit 1; }
  command -v npm  >/dev/null || { echo "✗ npm 未裝";  exit 1; }
fi

# ─── 1. 記錄當前版本 ──────────────────────────────
OLD_COMMIT="$(git rev-parse HEAD)"
OLD_VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo 'unknown')"

mkdir -p "$BACKUP_DIR"
exec > >(tee -a "$LOG") 2>&1

echo "═══════════════════════════════════════════════════"
echo "  tg-monitor-multi update · $TS · [$MODE mode]"
echo "═══════════════════════════════════════════════════"
echo "  當前版本:  $OLD_VERSION"
echo "  當前 commit: $OLD_COMMIT"
echo ""

# ─── 2. 備份 ───────────────────────────────────────
echo "▸ 備份 depts/ + data/ + global/ + secrets/ → $BACKUP_DIR"
[[ -d "$ROOT/depts"   ]] && cp -r "$ROOT/depts"   "$BACKUP_DIR/depts"
[[ -d "$ROOT/data"    ]] && cp -r "$ROOT/data"    "$BACKUP_DIR/data"
[[ -d "$ROOT/global"  ]] && cp -r "$ROOT/global"  "$BACKUP_DIR/global"
[[ -d "$ROOT/secrets" ]] && cp -r "$ROOT/secrets" "$BACKUP_DIR/secrets"

echo "$OLD_COMMIT"  > "$BACKUP_DIR/commit"
echo "$OLD_VERSION" > "$BACKUP_DIR/version"
echo "$TS"          > "$BACKUP_DIR/timestamp"
echo "$MODE"        > "$BACKUP_DIR/mode"
echo "  ✓ 備份完成"
echo ""

# ─── 3. git pull ───────────────────────────────────
echo "▸ 拉取新版 (git pull --ff-only)..."
git fetch origin
if ! git pull --ff-only; then
  echo ""
  echo "✗ git pull --ff-only 失敗 (有衝突 / 本地未 commit 改動)"
  echo "  本地代碼沒變, 備份仍在. 修正後重跑."
  exit 2
fi

NEW_COMMIT="$(git rev-parse HEAD)"
NEW_VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo 'unknown')"

if [[ "$OLD_COMMIT" == "$NEW_COMMIT" ]]; then
  echo "  ✓ 已是最新版, 沒有變化"
  echo "  (備份仍會保留, 可用 clean-backups.sh 清理)"
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
      echo "  考慮回滾: bash scripts/rollback.sh $BACKUP_DIR"
      exit 3
    fi
    sleep 1
  done

# ─── 4b. 裸跑模式: npm ci + pm2 reload ────────────
else
  echo "▸ 更新依賴 (npm ci)..."
  (cd "$ROOT" && npm ci --silent) || (cd "$ROOT/shared" && npm ci --silent && cd "$ROOT/web" && npm ci --silent)

  echo "▸ 重生 ecosystem.config.js..."
  node "$ROOT/scripts/generate-ecosystem.js"

  if command -v pm2 >/dev/null; then
    echo "▸ pm2 reload..."
    if [[ -f "$ROOT/ecosystem.config.js" ]]; then
      pm2 reload "$ROOT/ecosystem.config.js" 2>/dev/null || pm2 start "$ROOT/ecosystem.config.js"
      pm2 save >/dev/null
    else
      echo "  (ecosystem.config.js 不存在, 跳過 — 尚無部門)"
    fi
  else
    echo "⚠ pm2 未安裝, 跳過重啟. 手動處理."
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ 升級完成: $OLD_VERSION → $NEW_VERSION  [$MODE]"
echo "═══════════════════════════════════════════════════"
echo ""
echo "備份: $BACKUP_DIR"
echo ""
echo "若此次升級有問題, 回滾:"
echo "  bash $ROOT/scripts/rollback.sh $BACKUP_DIR"
echo ""
echo "列出所有備份: bash $ROOT/scripts/list-backups.sh"
