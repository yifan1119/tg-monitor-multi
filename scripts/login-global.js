#!/usr/bin/env node
// login-global.js — 全局进程 TG 登入 (CLI)
//
// 用法:
//   node scripts/login-global.js <kind>
//   node scripts/login-global.js title-sheet-writer
//   node scripts/login-global.js review-report-writer
//
// 会切到 global/<kind>/ 目录, 依手机号 / 验证码 / 2FA 产生 session.txt.

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const KINDS = ["title-sheet-writer", "review-report-writer"];

const kind = process.argv[2];
if (!kind || !KINDS.includes(kind)) {
  console.error("用法: node scripts/login-global.js <kind>");
  console.error(`kind: ${KINDS.join(" | ")}`);
  process.exit(1);
}

const targetDir = path.join(ROOT, "global", kind);
if (!fs.existsSync(targetDir)) {
  console.error(`✗ 不存在: global/${kind}/`);
  console.error(`   先跑: node scripts/new-global.js ${kind}`);
  process.exit(1);
}

// 切 cwd 让 dotenv 和 session.txt 用相对路径自动对
process.chdir(targetDir);
console.log(`▸ cwd: ${targetDir}`);

require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error(`✗ 缺少 TG_API_ID 或 TG_API_HASH (global/${kind}/.env)`);
  process.exit(1);
}

const SESSION_FILE = "./session.txt";
const sessionString = fs.existsSync(SESSION_FILE)
  ? fs.readFileSync(SESSION_FILE, "utf8").trim()
  : "";

(async () => {
  console.log(`开始登入 Telegram (${kind})...`);

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("手机号 (含国码, 如 +8613800138000): "),
    password:    async () => await input.password("两步验证密码 (没有直接 Enter): "),
    phoneCode:   async () => await input.text("验证码: "),
    onError:     (err) => console.log("错误:", err.message || err),
  });

  const me = await client.getMe();
  const saved = client.session.save();
  fs.writeFileSync(SESSION_FILE, saved, "utf8");

  console.log("\n✓ 登入成功");
  console.log("  Account:", {
    id: me.id?.toString(),
    username: me.username || "",
    firstName: me.firstName || "",
  });
  console.log(`  session 已写入 global/${kind}/session.txt (${saved.length} bytes)`);
  console.log("\n下一步:");
  console.log(`  1. 确认 global/${kind}/config.json 已填好 routes / inputChatNames / spreadsheetId`);
  console.log(`  2. 确认此号已加入 config.json 列出的所有群`);
  console.log(`  3. 重生 ecosystem: node scripts/generate-ecosystem.js`);
  console.log(`  4. 启动: pm2 start ecosystem.config.js --only tg-${kind}`);

  await client.disconnect();
  process.exit(0);
})();
