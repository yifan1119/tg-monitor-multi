#!/usr/bin/env bash
# clean-backups.sh — 清理舊備份, 只保留最近 N 個
#
# 用法:
#   bash scripts/clean-backups.sh            # 預設保留 5 個
#   bash scripts/clean-backups.sh --keep 10  # 保留 10 個
#   bash scripts/clean-backups.sh --all      # 全刪 (危險)
#   bash scripts/clean-backups.sh --dry-run  # 只印不刪

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
    *) echo "未知參數: $1"; exit 1 ;;
  esac
done

[[ ! -d "$BACKUPS" ]] && { echo "沒有備份"; exit 0; }

# 列出所有備份 (新 → 舊)
mapfile -t ALL_BACKUPS < <(ls -1dt "$BACKUPS"/*/ 2>/dev/null)
TOTAL=${#ALL_BACKUPS[@]}

if [[ $TOTAL -eq 0 ]]; then
  echo "沒有備份"
  exit 0
fi

if [[ $ALL -eq 1 ]]; then
  TO_DELETE=("${ALL_BACKUPS[@]}")
  TO_KEEP=()
else
  TO_KEEP=("${ALL_BACKUPS[@]:0:$KEEP}")
  TO_DELETE=("${ALL_BACKUPS[@]:$KEEP}")
fi

echo "共 $TOTAL 個備份"
echo "保留最近 ${#TO_KEEP[@]} 個, 刪除 ${#TO_DELETE[@]} 個"
echo ""

if [[ ${#TO_DELETE[@]} -eq 0 ]]; then
  echo "✓ 沒有需要刪除的備份"
  exit 0
fi

for dir in "${TO_DELETE[@]}"; do
  ts=$(basename "$dir" | sed 's|/$||')
  size=$(du -sh "$dir" 2>/dev/null | cut -f1)
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  [DRY] 會刪: $ts ($size)"
  else
    rm -rf "$dir"
    echo "  ✓ 刪除: $ts ($size)"
  fi
done

if [[ $DRY_RUN -eq 1 ]]; then
  echo ""
  echo "(DRY RUN - 沒真的刪. 去掉 --dry-run 才真刪)"
fi
