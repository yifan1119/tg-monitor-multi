// web/lib/admin-reset.js
//
// 忘记密码 + 绑定 TG 管理员. 辅助函数, 不含 Express.
//
// 数据文件:
//   data/pending-binds.json   — { code: { tg_user_id, tg_username, expires_at } }
//   data/pending-resets.json  — { username: { code, expires_at, attempts, used, created_at } }
//
// 流程:
//   绑定: /settings 点"绑定 TG" → 生成 6 位 bind code → 用户在 bot 发 /bind <code>
//         → bot 记录 tg_user_id 到 system.json adminTgUserId
//   重置: /login 点"忘记密码" → 填用户名 → 若已绑 TG, bot DM 发 6 位验证码
//         → /reset-password 填码 + 新密码 → 更新 bcrypt hash

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT, "data");
const PENDING_BINDS = path.join(DATA_DIR, "pending-binds.json");
const PENDING_RESETS = path.join(DATA_DIR, "pending-resets.json");
const SYSTEM_JSON = path.join(DATA_DIR, "system.json");

const BIND_TTL_MS = 10 * 60 * 1000;    // 10 分钟
const RESET_TTL_MS = 5 * 60 * 1000;    // 5 分钟
const RESET_RATE_LIMIT_MS = 60 * 1000; // 同用户 60s 内最多发一次
const MAX_RESET_ATTEMPTS = 5;

function _loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}
function _saveJson(p, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}
function _cleanExpired(obj) {
  const now = Date.now();
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === "object" && Number(v.expires_at) >= now) out[k] = v;
  }
  return out;
}

function _randCode(len = 6, alpha = "0123456789") {
  let s = "";
  for (let i = 0; i < len; i++) s += alpha[crypto.randomInt(alpha.length)];
  return s;
}

// ─── 绑定 TG ─────────────────────────────────────
function createBindPending() {
  const binds = _cleanExpired(_loadJson(PENDING_BINDS));
  // 6 位字母数字混合, 区分大小写更难撞
  let code;
  do {
    code = _randCode(6, "ABCDEFGHJKMNPQRSTUVWXYZ23456789"); // 去混淆字符
  } while (binds[code]);
  binds[code] = { expires_at: Date.now() + BIND_TTL_MS, created_at: Date.now() };
  _saveJson(PENDING_BINDS, binds);
  return code;
}

// bot 收到 /bind <code> 时调. 返回 true 表示绑定成功.
function consumeBindCode(code, tgUserId, tgUsername) {
  const binds = _cleanExpired(_loadJson(PENDING_BINDS));
  if (!binds[code]) return false;
  delete binds[code];
  _saveJson(PENDING_BINDS, binds);

  // 写入 system.json
  const sys = _loadJson(SYSTEM_JSON);
  sys.adminTgUserId = Number(tgUserId);
  sys.adminTgUsername = tgUsername || "";
  sys.adminTgBoundAt = new Date().toISOString();
  _saveJson(SYSTEM_JSON, sys);
  return true;
}

function getBindStatus() {
  const sys = _loadJson(SYSTEM_JSON);
  return {
    bound: !!sys.adminTgUserId,
    tg_user_id: sys.adminTgUserId || null,
    tg_username: sys.adminTgUsername || "",
    bound_at: sys.adminTgBoundAt || null,
  };
}

function unbind() {
  const sys = _loadJson(SYSTEM_JSON);
  delete sys.adminTgUserId;
  delete sys.adminTgUsername;
  delete sys.adminTgBoundAt;
  _saveJson(SYSTEM_JSON, sys);
}

// ─── 忘记密码 ────────────────────────────────────
// 返回 code 或 null (频率限制)
function createResetPending(username) {
  const resets = _cleanExpired(_loadJson(PENDING_RESETS));
  const existing = resets[username];
  if (existing && Date.now() - Number(existing.created_at || 0) < RESET_RATE_LIMIT_MS) {
    return null;
  }
  const code = _randCode(6, "0123456789"); // 6 位纯数字, 用户输入方便
  resets[username] = {
    code,
    created_at: Date.now(),
    expires_at: Date.now() + RESET_TTL_MS,
    attempts: 0,
    used: false,
  };
  _saveJson(PENDING_RESETS, resets);
  return code;
}

// 返回 { ok: boolean, reason?: string }
function consumeResetCode(code, username) {
  const resets = _cleanExpired(_loadJson(PENDING_RESETS));
  const entry = resets[username];
  if (!entry) return { ok: false, reason: "no_pending" };
  if (entry.used) return { ok: false, reason: "used" };
  if (Number(entry.attempts || 0) >= MAX_RESET_ATTEMPTS) {
    delete resets[username];
    _saveJson(PENDING_RESETS, resets);
    return { ok: false, reason: "too_many_attempts" };
  }
  if (String(code) !== String(entry.code)) {
    entry.attempts = Number(entry.attempts || 0) + 1;
    resets[username] = entry;
    _saveJson(PENDING_RESETS, resets);
    return { ok: false, reason: "wrong_code", attempts_left: MAX_RESET_ATTEMPTS - entry.attempts };
  }
  // 成功, 清理
  delete resets[username];
  _saveJson(PENDING_RESETS, resets);
  return { ok: true };
}

module.exports = {
  createBindPending, consumeBindCode, getBindStatus, unbind,
  createResetPending, consumeResetCode,
  BIND_TTL_MS, RESET_TTL_MS,
};
