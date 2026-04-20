#!/usr/bin/env bash
# new-dept.sh — 新增部門（thin wrapper over new-dept.js）
#
# 用法:
#   bash scripts/new-dept.sh <dept_name> <display> "<output_chat>" <spreadsheet_id> "<sheet_tab>"
#
# 範例:
#   bash scripts/new-dept.sh demo1 示例部门 "DEMO-业务群" 1Q9pMXg5... "关键词提醒d1"

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/new-dept.js" "$@"
