// web/lib/session-watcher.js
//
// 定期扫描 depts/*/state/session-dead.json, 新发现的死 session 经 admin bot DM 管理员.
// 已通知过的会记在 notified-sessions.json (按 ts+reason 去重), 避免刷屏.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DEPTS_DIR = path.join(ROOT, "depts");
const DATA_DIR = path.join(ROOT, "data");
const NOTIFIED_FILE = path.join(DATA_DIR, "notified-sessions.json");
const SYSTEM_JSON = path.join(DATA_DIR, "system.json");

const adminBot = require("./tg-admin-bot");

function _loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}
function _saveJson(p, obj) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

async function scanOnce() {
  const sys = _loadJson(SYSTEM_JSON);
  if (!sys.adminTgUserId) return; // 没绑定就不推

  if (!fs.existsSync(DEPTS_DIR)) return;
  const notified = _loadJson(NOTIFIED_FILE);
  let changed = false;

  for (const dept of fs.readdirSync(DEPTS_DIR)) {
    if (dept.startsWith(".") || dept.startsWith("_")) continue;
    const deadFile = path.join(DEPTS_DIR, dept, "state", "session-dead.json");
    if (!fs.existsSync(deadFile)) {
      // 如果部门复活了, 清理通知记录 (下次死再推)
      if (notified[dept]) { delete notified[dept]; changed = true; }
      continue;
    }
    const info = _loadJson(deadFile);
    if (!info.ts) continue;
    const key = `${dept}:${info.ts}`;
    if (notified[dept] === key) continue; // 已经推过这一次

    // 推
    const text =
      `⚠ 部门 [${dept}] TG session 失效\n\n` +
      `时间: ${info.ts}\n` +
      `原因: ${info.reason || "未知"}\n\n` +
      `处理: 去 Web 后台 /depts/${dept}/login 重新登入 TG`;
    const r = await adminBot.sendResetCode ? adminBot.status() : { running: false };
    try {
      // 借 bot 直接调 sendMessage, adminBot 模块里没暴露. 复用 sendResetCode 的底层
      const sent = await sendViaBot(sys.adminTgUserId, text);
      if (sent) {
        notified[dept] = key;
        changed = true;
        console.log(`[session-watcher] 已 DM 管理员: ${dept} session 死 (${info.ts})`);
      }
    } catch (e) {
      console.warn(`[session-watcher] DM 失败 ${dept}:`, e.message);
    }
  }

  if (changed) _saveJson(NOTIFIED_FILE, notified);
}

// 内部: 直接调 adminBot 的内部 bot 实例
// 不想改动 tg-admin-bot 接口, 这里复用 sendResetCode 但自定义文字
async function sendViaBot(userId, text) {
  // 复用 adminBot.sendResetCode 不行 (它固定文案), 改成曝露一个通用 DM 接口更干净
  // 见 tg-admin-bot.js 新增的 sendDM()
  if (typeof adminBot.sendDM === "function") {
    const r = await adminBot.sendDM(userId, text);
    return r.ok;
  }
  // 老版本 fallback
  return false;
}

let _timer = null;
function start(intervalMs = 5 * 60 * 1000) {
  if (_timer) clearInterval(_timer);
  // 首次延迟 30s, 让 bot 先起来
  setTimeout(() => scanOnce().catch(() => {}), 30 * 1000);
  _timer = setInterval(() => scanOnce().catch(() => {}), intervalMs);
  _timer.unref();
}

module.exports = { start, scanOnce };
