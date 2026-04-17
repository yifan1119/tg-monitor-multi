#!/usr/bin/env bash
# healthcheck.sh — 每 5 分钟跑 (由 cron 触发, 不手动跑)
#
# 对齐 baseline 逻辑:
#   - 扫 PM2 所有 tg-* 进程
#   - 对“非 listener”进程: 状态 != online → pm2 restart
#   - 对“listener”进程: 不动 (因 restart 会掉 TG session, 需人工处理)
#
# 为什么 listener 不自动重启:
#   - gram.js 重连几秒, 期间错过讯息 (虽有 backfill, 但频繁重启 TG 会风控)
#   - listener 坏了通常是 session.txt 失效 (要人重登), 不是软错误
#
# 支援的自动重启目标:
#   - tg-system-events-*     每部门 1 个
#   - tg-sheet-writer-*      每部门 1 个
#   - tg-title-sheet-writer  全局 1 个
#   - tg-review-report-writer 全局 1 个

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/.healthcheck"
LOG_FILE="$LOG_DIR/healthcheck.log"
mkdir -p "$LOG_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 防重入 (若上一次还没跑完, 跳过)
LOCK="$LOG_DIR/.lock"
if [[ -f "$LOCK" ]]; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || echo 0) ))
  if [[ $age -lt 300 ]]; then
    echo "[$(ts)] 上一次还在跑 (${age}s ago), 跳过" >> "$LOG_FILE"
    exit 0
  fi
fi
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# 取得所有 PM2 进程列表
pm2_list=$(pm2 jlist 2>/dev/null)
if [[ -z "$pm2_list" || "$pm2_list" == "[]" ]]; then
  echo "[$(ts)] pm2 没跑或没进程" >> "$LOG_FILE"
  exit 0
fi

# 解析出 tg-* 进程, 排除 listener
# 用 node 解析 JSON (确保跨平台)
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
  echo "[$(ts)] 扫完 $checked 个, 重启了 $restarted 个" >> "$LOG_FILE"
fi

# 保持日志不无限膨胀 — 超过 5MB 轮替
if [[ -f "$LOG_FILE" ]]; then
  size=$(stat -f %z "$LOG_FILE" 2>/dev/null || stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)
  if [[ $size -gt 5242880 ]]; then
    mv "$LOG_FILE" "$LOG_FILE.1"
    echo "[$(ts)] log rotated" > "$LOG_FILE"
  fi
fi
