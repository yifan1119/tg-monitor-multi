// web/lib/tg-admin-bot.js
//
// TG 管理员 bot — 只做两件事:
//   1. /bind <code> — 绑定 bot 聊天用户 → 系统管理员 (给 forgot password 用)
//   2. sendResetCode(userId, code) — web 后端调, DM 发 6 位验证码
//
// token 存 data/system.json 的 botToken 字段.
// 长连接 (polling) 在 web 进程里跑, 不占额外进程 —
// 轻量只处理几个命令, 比开 webhook 省心.

"use strict";

const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

const adminReset = require("./admin-reset");
const auditLog = require("./auth-audit");

const ROOT = path.resolve(__dirname, "..", "..");
const SYSTEM_JSON = path.join(ROOT, "data", "system.json");

let bot = null;
let currentToken = null;

function readSystem() {
  try { return JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")); } catch { return {}; }
}

function _stop() {
  if (bot) {
    try { bot.stopPolling({ cancel: true }).catch(() => {}); } catch {}
    bot = null;
  }
  currentToken = null;
}

function start() {
  const sys = readSystem();
  const token = sys.botToken || "";
  if (!token) {
    if (bot) { console.log("[admin-bot] BOT_TOKEN 被清空, 停止 bot"); _stop(); }
    return;
  }
  if (currentToken === token && bot) return; // 已在跑

  _stop();
  try {
    bot = new TelegramBot(token, { polling: true });
    currentToken = token;

    bot.on("polling_error", (err) => {
      // 401 = token 坏了; 忽略其他噪声
      const msg = String(err?.message || err);
      if (msg.includes("401") || msg.includes("ETELEGRAM")) {
        console.error("[admin-bot] polling error:", msg);
      }
    });

    bot.onText(/^\/start\b/, async (msg) => {
      try {
        await bot.sendMessage(msg.chat.id,
          "👋 这是 tg-monitor-multi 的管理员 bot.\n\n" +
          "要绑定你的管理员账号 (用于忘记密码找回):\n" +
          "1. 去 Web 后台 /settings 点「绑定 TG」, 拿到 6 位码\n" +
          "2. 回来发: /bind ABC123");
      } catch (e) { /* ignore */ }
    });

    bot.onText(/^\/bind\s+([A-Z0-9]{6})$/i, async (msg, match) => {
      const code = (match[1] || "").toUpperCase();
      const userId = msg.from?.id;
      const username = msg.from?.username || "";
      if (!userId) return;
      const ok = adminReset.consumeBindCode(code, userId, username);
      if (ok) {
        auditLog.log("tg_bind_success", { tg_user_id: userId, tg_username: username });
        try {
          await bot.sendMessage(msg.chat.id, `✓ 绑定成功!\n\n以后忘记密码, 来 Web 登入页点「忘记密码」, 我会 DM 发 6 位验证码给你.`);
        } catch {}
      } else {
        auditLog.log("tg_bind_fail", { tg_user_id: userId, tg_username: username, code });
        try {
          await bot.sendMessage(msg.chat.id, "✗ 码无效或已过期. 回 Web 后台重新生成.");
        } catch {}
      }
    });

    // 任何其他消息, 提示正确用法
    bot.on("message", async (msg) => {
      const text = (msg.text || "").trim();
      if (!text) return;
      if (text.startsWith("/start") || text.startsWith("/bind")) return;
      try {
        await bot.sendMessage(msg.chat.id,
          "只懂两条命令:\n/start — 查看用法\n/bind <6位码> — 绑定管理员");
      } catch {}
    });

    console.log("[admin-bot] 已启动 (polling)");
  } catch (e) {
    console.error("[admin-bot] 启动失败:", e.message);
    _stop();
  }
}

async function sendResetCode(userId, code) {
  return sendDM(userId,
    `🔑 密码重置验证码: ${code}\n\n5 分钟有效, 只能用一次.\n如果不是你操作的请忽略.`);
}

// 通用 DM — 给 session-watcher 等其他模块用
async function sendDM(userId, text) {
  if (!bot) return { ok: false, error: "bot 未启动 (检查 botToken)" };
  try {
    await bot.sendMessage(userId, text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function status() {
  const sys = readSystem();
  return {
    configured: !!sys.botToken,
    running: !!bot,
    bound: !!sys.adminTgUserId,
    tg_user_id: sys.adminTgUserId || null,
    tg_username: sys.adminTgUsername || "",
  };
}

// 启动时拉一次; web 收到 token 更新后调 restart()
function restart() { _stop(); start(); }

module.exports = { start, restart, sendResetCode, sendDM, status };
