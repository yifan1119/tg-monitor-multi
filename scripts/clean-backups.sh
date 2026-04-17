#!/usr/bin/env bash
# clean-backups.sh — 清理旧备份, 只保留最近 N 个
#
# 用法:
#   bash scripts/clean-backups.sh            # 预设保留 5 个
#   bash scripts/clean-backups.sh --keep 10  # 保留 10 个
#   bash scripts/clean-backups.sh --all      # 全删 (危险)
#   bash scripts/clean-backups.sh --dry-run  # 只印不删

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUPS="$ROOT/.backups"

KEEP=5
DRY_RUN=0
ALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP="$2"; shift 2 ;;
    --all) ALL=1; shift ;;
    --dry-run|-n) DRY_RUN=1; shift ;;
    -h|--help)
      echo "用法: $0 [--keep N] [--all] [--dry-run]"
      exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

[[ ! -d "$BACKUPS" ]] && { echo "没有备份"; exit 0; }

# 列出所有备份 (新 → 旧)
mapfile -t ALL_BACKUPS < <(ls -1dt "$BACKUPS"/*/ 2>/dev/null)
TOTAL=${#ALL_BACKUPS[@]}

if [[ $TOTAL -eq 0 ]]; then
  echo "没有备份"
  exit 0
fi

if [[ $ALL -eq 1 ]]; then
  TO_DELETE=("${ALL_BACKUPS[@]}")
  TO_KEEP=()
else
  TO_KEEP=("${ALL_BACKUPS[@]:0:$KEEP}")
  TO_DELETE=("${ALL_BACKUPS[@]:$KEEP}")
fi

echo "共 $TOTAL 个备份"
echo "保留最近 ${#TO_KEEP[@]} 个, 删除 ${#TO_DELETE[@]} 个"
echo ""

if [[ ${#TO_DELETE[@]} -eq 0 ]]; then
  echo "✓ 没有需要删除的备份"
  exit 0
fi

for dir in "${TO_DELETE[@]}"; do
  ts=$(basename "$dir" | sed 's|/$||')
  size=$(du -sh "$dir" 2>/dev/null | cut -f1)
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [DRY] 会删: $ts ($size)"
  else
    rm -rf "$dir"
    echo "  ✓ 删除: $ts ($size)"
  fi
done

if [[ $DRY_RUN -eq 1 ]]; then
  echo ""
  echo "(DRY RUN - 没真的删. 去掉 --dry-run 才真删)"
fi
