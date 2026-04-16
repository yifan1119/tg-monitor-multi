#!/usr/bin/env bash
# update.sh — 從 git 拉新版並重啟. 用戶資料 (depts/, data/) 自動備份.
#
# 流程:
#   1. 記錄當前 commit + 版號
#   2. 備份 depts/ + data/ 到 .backups/<timestamp>/
#   3. git fetch + pull --ff-only  (不允許 merge, 確保乾淨)
#   4. npm ci (嚴格按 package-lock.json)
#   5. 重生 ecosystem.config.js
#   6. pm2 reload 所有 tg-* 進程
#
# 失敗時:
#   - git pull 失敗 → 本地沒改動, 直接退出
#   - npm ci 失敗 → 備份在, 可手動回滾: bash scripts/rollback.sh .backups/<latest>/
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

# ─── 預檢 ──────────────────────────────────────────
command -v git >/dev/null || { echo "✗ git 未安裝"; exit 1; }
command -v node >/dev/null || { echo "✗ node 未安裝"; exit 1; }
command -v npm >/dev/null || { echo "✗ npm 未安裝"; exit 1; }
[[ -d "$ROOT/.git" ]] || { echo "✗ 不是 git repo: $ROOT"; exit 1; }

# ─── 1. 記錄當前版本 ──────────────────────────────
OLD_COMMIT="$(git rev-parse HEAD)"
OLD_VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || echo 'unknown')"

mkdir -p "$BACKUP_DIR"
exec > >(tee -a "$LOG") 2>&1

echo "═══════════════════════════════════════════════════"
echo "  tg-monitor-multi update · $TS"
echo "═══════════════════════════════════════════════════"
echo "  當前版本: $OLD_VERSION"
echo "  當前 commit: $OLD_COMMIT"
echo ""

# ─── 2. 備份 ───────────────────────────────────────
echo "▸ 備份 depts/ + data/ 到 $BACKUP_DIR ..."
if [[ -d "$ROOT/depts" ]]; then
  cp -r "$ROOT/depts" "$BACKUP_DIR/depts"
fi
if [[ -d "$ROOT/data" ]]; then
  cp -r "$ROOT/data" "$BACKUP_DIR/data"
fi
# 記錄 commit + version, 讓 rollback 能用
echo "$OLD_COMMIT" > "$BACKUP_DIR/commit"
echo "$OLD_VERSION" > "$BACKUP_DIR/version"
echo "$TS" > "$BACKUP_DIR/timestamp"

echo "  ✓ 備份完成"
echo ""

# ─── 3. git pull ───────────────────────────────────
echo "▸ 拉取新版..."
git fetch origin
if ! git pull --ff-only; then
  echo ""
  echo "✗ git pull --ff-only 失敗"
  echo "  可能原因: 本地有未 commit 改動、或分支有衝突"
  echo "  本地狀態沒動. 如果要強制覆蓋, 手動處理後重跑."
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

# ─── 4. npm ci ─────────────────────────────────────
echo "▸ 更新依賴 (shared/)..."
(cd "$ROOT/shared" && npm ci --silent)

echo "▸ 更新依賴 (web/)..."
(cd "$ROOT/web" && npm ci --silent)
echo ""

# ─── 5. 重生 ecosystem ────────────────────────────
echo "▸ 重生 ecosystem.config.js..."
node "$ROOT/scripts/generate-ecosystem.js"
echo ""

# ─── 6. 重啟 PM2 ───────────────────────────────────
if command -v pm2 >/dev/null; then
  echo "▸ PM2 reload..."
  if [[ -f "$ROOT/ecosystem.config.js" ]]; then
    # reload = 零停機 (若有 autorestart)
    pm2 reload "$ROOT/ecosystem.config.js" 2>/dev/null || pm2 start "$ROOT/ecosystem.config.js"
    pm2 save >/dev/null
  else
    echo "  (ecosystem.config.js 不存在, 跳過 — 尚無部門)"
  fi
else
  echo "⚠ pm2 未安裝, 跳過重啟"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ 升級完成: $OLD_VERSION → $NEW_VERSION"
echo "═══════════════════════════════════════════════════"
echo ""
echo "備份: $BACKUP_DIR"
echo ""
echo "若此次升級有問題, 回滾:"
echo "  bash $ROOT/scripts/rollback.sh $BACKUP_DIR"
echo ""
echo "列出所有備份: bash $ROOT/scripts/list-backups.sh"
