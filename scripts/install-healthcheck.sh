#!/usr/bin/env bash
# install-healthcheck.sh — 安装 / 移除 cron 健康检查
#
# 用法:
#   bash scripts/install-healthcheck.sh          # 装: 每 5 分钟跑一次
#   bash scripts/install-healthcheck.sh --status # 看状态
#   bash scripts/install-healthcheck.sh --remove # 移除

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_PATH="$ROOT/scripts/healthcheck.sh"
CRON_MARKER="# tg-monitor-multi healthcheck"
CRON_LINE="*/5 * * * * $SCRIPT_PATH >/dev/null 2>&1 $CRON_MARKER"

ACTION="${1:-install}"

case "$ACTION" in
  --status|-s|status)
    if crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
      echo "✓ healthcheck cron 已启用"
      crontab -l | grep -F "$CRON_MARKER"
      echo ""
      if [[ -f "$ROOT/.healthcheck/healthcheck.log" ]]; then
        echo "最近 5 条 log:"
        tail -5 "$ROOT/.healthcheck/healthcheck.log"
      else
        echo "(尚无 log, 可能还没跑过第一次)"
      fi
    else
      echo "✗ healthcheck cron 未启用"
      echo "  执行 bash scripts/install-healthcheck.sh 启用"
    fi
    ;;

  --remove|-r|remove|off)
    if crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
      crontab -l 2>/dev/null | grep -vF "$CRON_MARKER" | crontab -
      echo "✓ 已移除 healthcheck cron"
    else
      echo "(本来就没装)"
    fi
    ;;

  install|--install|on|"")
    if [[ ! -x "$SCRIPT_PATH" ]]; then
      chmod +x "$SCRIPT_PATH"
    fi
    # 先移除旧的 (避免重复)
    ( crontab -l 2>/dev/null | grep -vF "$CRON_MARKER" ; echo "$CRON_LINE" ) | crontab -
    echo "✓ healthcheck cron 已启用 (每 5 分钟)"
    echo "  $CRON_LINE"
    echo ""
    echo "看状态:  bash scripts/install-healthcheck.sh --status"
    echo "移除:    bash scripts/install-healthcheck.sh --remove"
    echo "看日志:  tail -f .healthcheck/healthcheck.log"
    ;;

  *)
    echo "用法: $0 [install | --status | --remove]"
    exit 1
    ;;
esac
