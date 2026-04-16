#!/usr/bin/env bash
# new-dept.sh — 新增部門（D2 會擴充功能，這是 D1 佔位版）
#
# 用法:
#   bash scripts/new-dept.sh <dept_name>
#
# D2 擴充後:
#   bash scripts/new-dept.sh <dept_name> "<中轉群名>" <spreadsheet_id> "<sheet 分頁名>"
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPT_NAME="${1:-}"

if [[ -z "$DEPT_NAME" ]]; then
  echo "Usage: $0 <dept_name>"
  exit 1
fi

# 命名驗證
if [[ ! "$DEPT_NAME" =~ ^[a-z][a-z0-9-]{1,31}$ ]]; then
  echo "❌ dept_name 必須符合: 小寫字母開頭, 2-32 字符, 只含 a-z / 0-9 / -"
  exit 1
fi

# 保留字
if [[ "$DEPT_NAME" == "_template" || "$DEPT_NAME" == "_shared" || "$DEPT_NAME" == "root" ]]; then
  echo "❌ $DEPT_NAME 是保留字"
  exit 1
fi

TARGET="$ROOT/depts/$DEPT_NAME"

if [[ -d "$TARGET" ]]; then
  echo "❌ 部門已存在: $TARGET"
  exit 1
fi

# 從 _template 複製
cp -r "$ROOT/depts/_template" "$TARGET"
mv "$TARGET/config.json.example" "$TARGET/config.json"
mv "$TARGET/.env.example" "$TARGET/.env"
rm -f "$TARGET/session.txt.example"
mkdir -p "$TARGET/state"

echo "✅ 部門已建立: $TARGET"
echo
echo "下一步:"
echo "  1. 編輯 $TARGET/config.json（填入 outputChatName / spreadsheetId / sheetName）"
echo "  2. 編輯 $TARGET/.env（填 TG_API_ID / TG_API_HASH）"
echo "  3. 跑登入: cd $TARGET && node $ROOT/scripts/login-dept.js"
echo "  4. 啟動進程: pm2 start $ROOT/ecosystem.config.js --only tg-*-$DEPT_NAME"
