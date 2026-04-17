// web/lib/tg-login.js
//
// TG 登入 Web 流程 (gram.js verify-code). 跨请求保持 client 实例.
// 支持两种 target:
//   - type="dept",   name="<dept>"  → depts/<dept>/session.txt
//   - type="global", name="<kind>"  → global/<kind>/session.txt
//
// 用法:
//   const { makeTarget } = require("./tg-login");
//   const t = makeTarget("dept", "demo1");      // 或 makeTarget("global", "title-sheet-writer")
//   await startLogin(t, phone);
//   await submitCode(t, code);
//   await submitPassword(t, password);
//   abort(t); getStatus(t);

"use strict";

const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");

const ROOT = path.resolve(__dirname, "..", "..");

// target.key → session (cross-request state)
// status: "awaiting_code" | "awaiting_password"
const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions.entries()) {
    if (v.expiresAt < now) {
      try { v.client?.disconnect(); } catch {}
      sessions.delete(k);
    }
  }
}, 60 * 1000).unref();

// ═════════════════════════════════════════════════════
// Target: 统一抽象 "dept" 和 "global" 两种 TG 登入目标
// ═════════════════════════════════════════════════════

function makeTarget(type, name) {
  if (type !== "dept" && type !== "global") {
    throw new Error(`type 只能是 dept / global, 收到: ${type}`);
  }
  if (!name || typeof name !== "string") throw new Error("name 不能为空");
  const baseDir = type === "dept"
    ? path.join(ROOT, "depts", name)
    : path.join(ROOT, "global", name);
  return {
    type,
    name,
    baseDir,
    key: `${type}:${name}`,
    label: type === "dept" ? `部门 ${name}` : `全局进程 ${name}`,
  };
}

function targetExists(t) {
  return fs.existsSync(t.baseDir) && fs.statSync(t.baseDir).isDirectory();
}

function readEnvAt(t) {
  const envPath = path.join(t.baseDir, ".env");
  if (!fs.existsSync(envPath)) throw new Error(`找不到 .env: ${path.relative(ROOT, envPath)}`);
  const content = fs.readFileSync(envPath, "utf8");
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  if (!out.TG_API_ID || !out.TG_API_HASH) {
    throw new Error(`${t.label} 的 .env 中 TG_API_ID 或 TG_API_HASH 为空. 先去 /setup 填系统级, 或手动编辑 .env`);
  }
  return { apiId: Number(out.TG_API_ID), apiHash: out.TG_API_HASH };
}

// ═════════════════════════════════════════════════════
// Login state machine
// ═════════════════════════════════════════════════════

async function startLogin(t, phone) {
  if (!targetExists(t)) throw new Error(`${t.label} 不存在`);
  if (!phone || !/^\+?\d{7,15}$/.test(phone.replace(/\s/g, ""))) {
    throw new Error("手机号格式错. 请含国码, 例: +8613800138000");
  }
  const normalizedPhone = phone.replace(/\s/g, "");
  const { apiId, apiHash } = readEnvAt(t);

  const old = sessions.get(t.key);
  if (old) {
    try { old.client?.disconnect(); } catch {}
    sessions.delete(t.key);
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
  await client.connect();

  const result = await client.sendCode({ apiId, apiHash }, normalizedPhone);
  const phoneCodeHash = result.phoneCodeHash;

  sessions.set(t.key, {
    client,
    phone: normalizedPhone,
    phoneCodeHash,
    apiId, apiHash,
    target: t,
    status: "awaiting_code",
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return { ok: true, status: "awaiting_code", phone: normalizedPhone };
}

async function submitCode(t, code) {
  const sess = sessions.get(t.key);
  if (!sess) throw new Error("没有进行中的登入. 请先输入手机号取得验证码");
  if (sess.status !== "awaiting_code") throw new Error(`当前状态 ${sess.status}, 不接受验证码`);
  if (!code || !/^\d{4,7}$/.test(code.trim())) {
    throw new Error("验证码格式错 (应为 5-6 位数字)");
  }

  const { client, phone, phoneCodeHash } = sess;
  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber: phone,
      phoneCodeHash,
      phoneCode: code.trim(),
    }));
    return await finalizeLogin(t);
  } catch (e) {
    if (e.errorMessage === "SESSION_PASSWORD_NEEDED") {
      sess.status = "awaiting_password";
      sess.expiresAt = Date.now() + SESSION_TTL_MS;
      return { ok: true, status: "awaiting_password" };
    }
    throw new Error(`验证码错误: ${e.errorMessage || e.message}`);
  }
}

async function submitPassword(t, password) {
  const sess = sessions.get(t.key);
  if (!sess) throw new Error("没有进行中的登入");
  if (sess.status !== "awaiting_password") throw new Error(`当前状态 ${sess.status}, 不接受密码`);
  if (!password) throw new Error("2FA 密码不能为空");

  const { client } = sess;
  try {
    await client.signInWithPassword({ apiId: sess.apiId, apiHash: sess.apiHash }, {
      password: async () => password,
      onError: (err) => { throw err; },
    });
    return await finalizeLogin(t);
  } catch (e) {
    throw new Error(`2FA 密码错误: ${e.errorMessage || e.message}`);
  }
}

async function finalizeLogin(t) {
  const sess = sessions.get(t.key);
  if (!sess) throw new Error("session 不存在");

  const sessionString = sess.client.session.save();
  const sessionPath = path.join(t.baseDir, "session.txt");
  fs.writeFileSync(sessionPath, sessionString);
  console.log(`[tg-login] ✓ ${t.label} session 已写入 (${sessionString.length} bytes)`);

  try { await sess.client.disconnect(); } catch {}
  sessions.delete(t.key);

  return { ok: true, status: "done", bytes: sessionString.length };
}

function getStatus(t) {
  const s = sessions.get(t.key);
  if (!s) return { status: "idle" };
  return {
    status: s.status,
    phone: s.phone,
    expiresInMs: Math.max(0, s.expiresAt - Date.now()),
  };
}

function abort(t) {
  const sess = sessions.get(t.key);
  if (!sess) return { ok: false, reason: "没有进行中的登入" };
  try { sess.client?.disconnect(); } catch {}
  sessions.delete(t.key);
  return { ok: true };
}

module.exports = {
  makeTarget,
  startLogin,
  submitCode,
  submitPassword,
  getStatus,
  abort,
};
