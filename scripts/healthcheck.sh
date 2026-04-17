#!/usr/bin/env bash
# healthcheck.sh — 每 5 分鐘跑 (由 cron 觸發, 不手動跑)
#
# 對齊 baseline 邏輯:
#   - 掃 PM2 所有 tg-* 進程
#   - 對「非 listener」進程: 狀態 != online → pm2 restart
#   - 對「listener」進程: 不動 (因 restart 會掉 TG session, 需人工處理)
#
# 為什麼 listener 不自動重啟:
#   - gram.js 重連幾秒, 期間錯過訊息 (雖有 backfill, 但頻繁重啟 TG 會風控)
#   - listener 壞了通常是 session.txt 失效 (要人重登), 不是軟錯誤
#
# 支援的自動重啟目標:
#   - tg-system-events-*     每部門 1 個
#   - tg-sheet-writer-*      每部門 1 個
#   - tg-title-sheet-writer  全局 1 個
#   - tg-review-report-writer 全局 1 個

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/.healthcheck"
LOG_FILE="$LOG_DIR/healthcheck.log"
mkdir -p "$LOG_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 防重入 (若上一次還沒跑完, 跳過)
LOCK="$LOG_DIR/.lock"
if [[ -f "$LOCK" ]]; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || echo 0) ))
  if [[ $age -lt 300 ]]; then
    echo "[$(ts)] 上一次還在跑 (${age}s ago), 跳過" >> "$LOG_FILE"
    exit 0
  fi
fi
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# 取得所有 PM2 進程列表
pm2_list=$(pm2 jlist 2>/dev/null)
if [[ -z "$pm2_list" || "$pm2_list" == "[]" ]]; then
  echo "[$(ts)] pm2 沒跑或沒進程" >> "$LOG_FILE"
  exit 0
fi

# 解析出 tg-* 進程, 排除 listener
# 用 node 解析 JSON (確保跨平台)
mapfile -t SERVICES < <(node -e '
  const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const protect = list
    .filter(p => p.name && p.name.startsWith("tg-") && !p.name.startsWith("tg-listener-"))
    .map(p => `${p.name}\t${p.pm2_env?.status || "unknown"}`);
  console.log(protect.join("\n"));
' <<< "$pm2_list")

restarted=0
checked=0

for line in "${SERVICES[@]}"; do
  [[ -z "$line" ]] && continue
  name="${line%%	*}"
  status="${line#*	}"
  checked=$((checked + 1))

  if [[ "$status" != "online" ]]; then
    echo "[$(ts)] restart $name (status=$status)" >> "$LOG_FILE"
    if pm2 restart "$name" >> "$LOG_FILE" 2>&1; then
      restarted=$((restarted + 1))
    else
      echo "[$(ts)] restart FAILED $name" >> "$LOG_FILE"
    fi
  fi
done

if [[ $restarted -gt 0 ]]; then
  pm2 save >> "$LOG_FILE" 2>&1 || true
  echo "[$(ts)] 掃完 $checked 個, 重啟了 $restarted 個" >> "$LOG_FILE"
fi

# 保持日誌不無限膨脹 — 超過 5MB 輪替
if [[ -f "$LOG_FILE" ]]; then
  size=$(stat -f %z "$LOG_FILE" 2>/dev/null || stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)
  if [[ $size -gt 5242880 ]]; then
    mv "$LOG_FILE" "$LOG_FILE.1"
    echo "[$(ts)] log rotated" > "$LOG_FILE"
  fi
fi
