#!/usr/bin/env bash
# rollback.sh — 回滾到某次 update 前的狀態. 自動偵測 Docker / 裸跑模式.
#
# 用法:
#   bash scripts/rollback.sh                         # 列備份並提示
#   bash scripts/rollback.sh .backups/<timestamp>/   # 回滾到某次備份
#
# 流程:
#   1. 預備份當前狀態 → .backups/rollback-safety-<ts>/  (保命)
#   2. git reset --hard <old_commit>
#   3. 按模式重啟:
#      - Docker: docker compose up -d --build  (image rebuild 回舊版代碼)
#      - 裸跑:   npm ci + pm2 reload
#   4. 還原 depts/ + data/ + global/ + secrets/

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP="${1:-}"

# ─── 列備份 ──────────────────────────────────────────
list_backups() {
  echo ""
  echo "可用備份 (最近在上):"
  if [[ ! -d "$ROOT/.backups" ]]; then
    echo "  (沒有備份)"
    return
  fi
  local n=1
  for dir in $(ls -1dt "$ROOT/.backups"/*/ 2>/dev/null | head -10); do
    local ts=$(basename "$dir" | sed 's|/$||')
    local ver=$(cat "$dir/version" 2>/dev/null || echo "?")
    local commit=$(cat "$dir/commit" 2>/dev/null || echo "?")
    local mode=$(cat "$dir/mode" 2>/dev/null || echo "?")
    printf "  %d. %-32s  %-12s  %-12s  [%s]\n" "$n" "$ts" "$ver" "${commit:0:8}" "$mode"
    n=$((n+1))
  done
}

if [[ -z "$BACKUP" ]]; then
  echo "用法: bash scripts/rollback.sh <backup_dir>"
  list_backups
  echo ""
  echo "範例: bash scripts/rollback.sh $ROOT/.backups/20260416-130000/"
  exit 1
fi

# 相對路徑轉絕對
[[ "$BACKUP" != /* ]] && BACKUP="$ROOT/$BACKUP"
BACKUP="${BACKUP%/}"

# ─── 驗證備份 ───────────────────────────────────────
[[ -d "$BACKUP" ]] || { echo "✗ 備份目錄不存在: $BACKUP"; list_backups; exit 1; }
[[ -f "$BACKUP/commit" ]] || { echo "✗ 備份損壞: 缺 commit 檔"; exit 1; }

OLD_COMMIT="$(cat "$BACKUP/commit")"
OLD_VERSION="$(cat "$BACKUP/version" 2>/dev/null || echo '?')"
BACKUP_MODE="$(cat "$BACKUP/mode" 2>/dev/null || echo 'bare')"

CURRENT_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
CURRENT_VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo '?')"

# ─── 決定當前 mode (用 update.sh 的邏輯) ───────────
detect_mode() {
  if [[ -f "$ROOT/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1; then
    echo "docker"; return
  fi
  echo "bare"
}
CURRENT_MODE="${ROLLBACK_MODE:-$(detect_mode)}"

echo "═══════════════════════════════════════════════════"
echo "  tg-monitor-multi rollback · [$CURRENT_MODE mode]"
echo "═══════════════════════════════════════════════════"
echo "  當前: $CURRENT_VERSION ($CURRENT_COMMIT)  [$CURRENT_MODE]"
echo "  目標: $OLD_VERSION  ($OLD_COMMIT)  [$BACKUP_MODE]"
echo "  備份: $BACKUP"
echo ""

# ─── 1. 預備份當前狀態 (保命) ──────────────────────
SAFETY_TS="$(date +%Y%m%d-%H%M%S)"
SAFETY_BACKUP="$ROOT/.backups/rollback-safety-$SAFETY_TS"
mkdir -p "$SAFETY_BACKUP"
echo "▸ 預備份當前狀態 → $SAFETY_BACKUP"
[[ -d "$ROOT/depts"   ]] && cp -r "$ROOT/depts"   "$SAFETY_BACKUP/depts"
[[ -d "$ROOT/data"    ]] && cp -r "$ROOT/data"    "$SAFETY_BACKUP/data"
[[ -d "$ROOT/global"  ]] && cp -r "$ROOT/global"  "$SAFETY_BACKUP/global"
[[ -d "$ROOT/secrets" ]] && cp -r "$ROOT/secrets" "$SAFETY_BACKUP/secrets"
echo "$CURRENT_COMMIT"  > "$SAFETY_BACKUP/commit"
echo "$CURRENT_VERSION" > "$SAFETY_BACKUP/version"
echo "$SAFETY_TS"       > "$SAFETY_BACKUP/timestamp"
echo "$CURRENT_MODE"    > "$SAFETY_BACKUP/mode"
echo "  ✓ 若回滾失敗可用: bash scripts/rollback.sh $SAFETY_BACKUP"
echo ""

# ─── 2. git reset --hard ───────────────────────────
echo "▸ git reset --hard $OLD_COMMIT"
git -C "$ROOT" fetch origin >/dev/null 2>&1 || true
if ! git -C "$ROOT" reset --hard "$OLD_COMMIT"; then
  echo "✗ git reset 失敗"
  exit 2
fi
echo ""

# ─── 3. 還原 depts/ 和 data/ 和 global/ 和 secrets/ ──
echo "▸ 還原用戶資料..."
if [[ -d "$BACKUP/depts" ]];   then rm -rf "$ROOT/depts"   && cp -r "$BACKUP/depts"   "$ROOT/depts";   echo "  ✓ depts/"; fi
if [[ -d "$BACKUP/data" ]];    then rm -rf "$ROOT/data"    && cp -r "$BACKUP/data"    "$ROOT/data";    echo "  ✓ data/"; fi
if [[ -d "$BACKUP/global" ]];  then rm -rf "$ROOT/global"  && cp -r "$BACKUP/global"  "$ROOT/global";  echo "  ✓ global/"; fi
if [[ -d "$BACKUP/secrets" ]]; then rm -rf "$ROOT/secrets" && cp -r "$BACKUP/secrets" "$ROOT/secrets"; echo "  ✓ secrets/"; fi
echo ""

# ─── 4a. Docker 模式: rebuild + restart ───────────
if [[ "$CURRENT_MODE" == "docker" ]]; then
  echo "▸ docker compose up -d --build (回舊版代碼 rebuild)..."
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
      echo "  回滾前狀態仍可用: bash scripts/rollback.sh $SAFETY_BACKUP"
      exit 3
    fi
    sleep 1
  done

# ─── 4b. 裸跑模式: npm ci + pm2 reload ──────────────
else
  echo "▸ 重裝依賴 (npm ci)..."
  (cd "$ROOT" && npm ci --silent) || echo "⚠ npm ci 失敗, 繼續"

  echo "▸ 重生 ecosystem.config.js..."
  node "$ROOT/scripts/generate-ecosystem.js" || echo "⚠ ecosystem 生成失敗"

  if command -v pm2 >/dev/null; then
    echo "▸ pm2 reload..."
    [[ -f "$ROOT/ecosystem.config.js" ]] && pm2 reload "$ROOT/ecosystem.config.js" 2>/dev/null || pm2 start "$ROOT/ecosystem.config.js" 2>/dev/null || true
    pm2 save >/dev/null 2>&1 || true
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ 已回滾到 $OLD_VERSION ($OLD_COMMIT)  [$CURRENT_MODE]"
echo "═══════════════════════════════════════════════════"
echo ""
echo "若此次回滾也有問題, 可再回到回滾前狀態:"
echo "  bash scripts/rollback.sh $SAFETY_BACKUP"
