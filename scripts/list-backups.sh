#!/usr/bin/env bash
# list-backups.sh — 列出所有可用備份

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUPS="$ROOT/.backups"

if [[ ! -d "$BACKUPS" ]]; then
  echo "還沒有任何備份"
  exit 0
fi

count=0
total_size=0

printf "%-32s %-12s %-12s %-12s\n" "TIMESTAMP" "VERSION" "COMMIT" "SIZE"
printf "%-32s %-12s %-12s %-12s\n" "--------" "-------" "------" "----"

for dir in $(ls -1dt "$BACKUPS"/*/ 2>/dev/null); do
  ts=$(basename "$dir" | sed 's|/$||')
  ver=$(cat "$dir/version" 2>/dev/null || echo "?")
  commit=$(cat "$dir/commit" 2>/dev/null || echo "?")
  size=$(du -sh "$dir" 2>/dev/null | cut -f1)
  printf "%-32s %-12s %-12s %-12s\n" "$ts" "$ver" "${commit:0:8}" "$size"
  count=$((count + 1))
done

echo ""
echo "共 $count 個備份"
if [[ $count -gt 0 ]]; then
  total=$(du -sh "$BACKUPS" 2>/dev/null | cut -f1)
  echo "總大小: $total"
fi
echo ""
echo "回滾: bash scripts/rollback.sh .backups/<timestamp>/"
echo "清理: bash scripts/clean-backups.sh [--keep N]   (預設保留最近 5 個)"
