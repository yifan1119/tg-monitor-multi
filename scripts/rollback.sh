#!/usr/bin/env bash
# rollback.sh — 回滾到某次 update 前的狀態
#
# 用法:
#   bash scripts/rollback.sh                        # 列出可用備份, 提示選擇
#   bash scripts/rollback.sh .backups/20260416-130000/
#
# 做什麼:
#   1. 預備份: 先把當前的 depts/ + data/ 再備一份到 .backups/rollback-safety-<ts>/
#      (防回滾本身也出錯, 還能再回滾回來)
#   2. git reset --hard <old_commit>
#   3. npm ci  (裝回舊版 package-lock 的依賴)
#   4. 還原 depts/ 和 data/
#   5. 重生 ecosystem.config.js
#   6. pm2 reload

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP="${1:-}"

# ─── 列出備份並讓用戶選 ─────────────────────────────
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
    printf "  %d. %s  (%s @ %s)\n" "$n" "$ts" "$ver" "${commit:0:8}"
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

# 支援相對路徑
if [[ "$BACKUP" != /* ]]; then
  BACKUP="$ROOT/$BACKUP"
fi
BACKUP="${BACKUP%/}"  # 去尾斜線

# ─── 驗證備份 ───────────────────────────────────────
if [[ ! -d "$BACKUP" ]]; then
  echo "✗ 備份目錄不存在: $BACKUP"
  list_backups
  exit 1
fi
if [[ ! -f "$BACKUP/commit" ]]; then
  echo "✗ 備份損壞: 缺 commit 檔 ($BACKUP/commit)"
  exit 1
fi

OLD_COMMIT="$(cat "$BACKUP/commit")"
OLD_VERSION="$(cat "$BACKUP/version" 2>/dev/null || echo '?')"
CURRENT_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
CURRENT_VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo '?')"

echo "═══════════════════════════════════════════════════"
echo "  tg-monitor-multi rollback"
echo "═══════════════════════════════════════════════════"
echo "  當前: $CURRENT_VERSION ($CURRENT_COMMIT)"
echo "  目標: $OLD_VERSION  ($OLD_COMMIT)"
echo "  備份: $BACKUP"
echo ""

# ─── 1. 預備份當前狀態 (防回滾也出錯) ────────────
SAFETY_TS="$(date +%Y%m%d-%H%M%S)"
SAFETY_BACKUP="$ROOT/.backups/rollback-safety-$SAFETY_TS"
mkdir -p "$SAFETY_BACKUP"
echo "▸ 預備份當前狀態 → $SAFETY_BACKUP"
[[ -d "$ROOT/depts" ]] && cp -r "$ROOT/depts" "$SAFETY_BACKUP/depts"
[[ -d "$ROOT/data" ]]  && cp -r "$ROOT/data"  "$SAFETY_BACKUP/data"
echo "$CURRENT_COMMIT"  > "$SAFETY_BACKUP/commit"
echo "$CURRENT_VERSION" > "$SAFETY_BACKUP/version"
echo "$SAFETY_TS"       > "$SAFETY_BACKUP/timestamp"
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

# ─── 3. 重裝舊版依賴 ──────────────────────────────
echo "▸ 重裝依賴 (shared/)..."
(cd "$ROOT/shared" && npm ci --silent) || echo "⚠ shared/npm ci 失敗, 繼續"

echo "▸ 重裝依賴 (web/)..."
(cd "$ROOT/web" && npm ci --silent) || echo "⚠ web/npm ci 失敗, 繼續"
echo ""

# ─── 4. 還原 depts/ 和 data/ ─────────────────────
echo "▸ 還原 depts/ 和 data/..."
if [[ -d "$BACKUP/depts" ]]; then
  rm -rf "$ROOT/depts"
  cp -r "$BACKUP/depts" "$ROOT/depts"
  echo "  ✓ depts/"
fi
if [[ -d "$BACKUP/data" ]]; then
  rm -rf "$ROOT/data"
  cp -r "$BACKUP/data" "$ROOT/data"
  echo "  ✓ data/"
fi
echo ""

# ─── 5. 重生 ecosystem ────────────────────────────
echo "▸ 重生 ecosystem.config.js..."
node "$ROOT/scripts/generate-ecosystem.js" || echo "⚠ ecosystem 生成失敗"
echo ""

# ─── 6. 重啟 PM2 ───────────────────────────────────
if command -v pm2 >/dev/null; then
  echo "▸ PM2 reload..."
  if [[ -f "$ROOT/ecosystem.config.js" ]]; then
    pm2 reload "$ROOT/ecosystem.config.js" 2>/dev/null || pm2 start "$ROOT/ecosystem.config.js" || true
    pm2 save >/dev/null 2>&1 || true
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ 已回滾到 $OLD_VERSION ($OLD_COMMIT)"
echo "═══════════════════════════════════════════════════"
echo ""
echo "若此次回滾也有問題, 可再回到回滾前狀態:"
echo "  bash scripts/rollback.sh $SAFETY_BACKUP"
