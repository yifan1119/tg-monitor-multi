// web/lib/tg-login.js
//
// TG 登入 Web 流程 (gram.js verify-code). 跨請求保持 client 實例.
//
// 用法:
//   const loginMgr = require("./tg-login");
//   await loginMgr.startLogin(deptName, phone);        // sendCode
//   await loginMgr.submitCode(deptName, code);         // signIn → 若需 2FA 拋 SESSION_PASSWORD_NEEDED
//   await loginMgr.submitPassword(deptName, password); // checkPassword
//   loginMgr.abort(deptName);                          // 取消
//
// 成功後 session.txt 寫到 depts/<name>/, 並清掉 in-memory session.

"use strict";

const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram");

const ROOT = path.resolve(__dirname, "..", "..");
const DEPTS_DIR = path.join(ROOT, "depts");

// dept_name → { client, phone, phoneCodeHash, expiresAt, status }
// status: "awaiting_code" | "awaiting_password"
const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 分鐘

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions.entries()) {
    if (v.expiresAt < now) {
      try { v.client?.disconnect(); } catch {}
      sessions.delete(k);
    }
  }
}, 60 * 1000).unref();

function readDeptEnv(deptName) {
  const envPath = path.join(DEPTS_DIR, deptName, ".env");
  if (!fs.existsSync(envPath)) throw new Error(`找不到 .env: depts/${deptName}/.env`);
  const content = fs.readFileSync(envPath, "utf8");
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  if (!out.TG_API_ID || !out.TG_API_HASH) {
    throw new Error(`depts/${deptName}/.env 中 TG_API_ID 或 TG_API_HASH 為空. 先去 /setup 填`);
  }
  return { apiId: Number(out.TG_API_ID), apiHash: out.TG_API_HASH };
}

function deptExists(deptName) {
  return fs.existsSync(path.join(DEPTS_DIR, deptName)) &&
         fs.statSync(path.join(DEPTS_DIR, deptName)).isDirectory();
}

async function startLogin(deptName, phone) {
  if (!deptExists(deptName)) throw new Error(`部門不存在: ${deptName}`);
  if (!phone || !/^\+?\d{7,15}$/.test(phone.replace(/\s/g, ""))) {
    throw new Error("手機號格式錯. 請含國碼, 例: +8613800138000");
  }
  const normalizedPhone = phone.replace(/\s/g, "");

  const { apiId, apiHash } = readDeptEnv(deptName);

  // 若已有舊 session, 先關掉
  const old = sessions.get(deptName);
  if (old) {
    try { old.client?.disconnect(); } catch {}
    sessions.delete(deptName);
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
  });
  await client.connect();

  // sendCode (返回 phoneCodeHash)
  const result = await client.sendCode({ apiId, apiHash }, normalizedPhone);
  const phoneCodeHash = result.phoneCodeHash;

  sessions.set(deptName, {
    client,
    phone: normalizedPhone,
    phoneCodeHash,
    apiId, apiHash,
    status: "awaiting_code",
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return { ok: true, status: "awaiting_code", phone: normalizedPhone };
}

async function submitCode(deptName, code) {
  const sess = sessions.get(deptName);
  if (!sess) throw new Error("沒有進行中的登入. 請先輸入手機號取得驗證碼");
  if (sess.status !== "awaiting_code") throw new Error(`當前狀態 ${sess.status}, 不接受驗證碼`);
  if (!code || !/^\d{4,7}$/.test(code.trim())) {
    throw new Error("驗證碼格式錯 (應為 5-6 位數字)");
  }

  const { client, phone, phoneCodeHash } = sess;
  try {
    await client.invoke(new Api.auth.SignIn({
      phoneNumber: phone,
      phoneCodeHash,
      phoneCode: code.trim(),
    }));
    // 登入成功, 寫 session.txt
    return await finalizeLogin(deptName);
  } catch (e) {
    if (e.errorMessage === "SESSION_PASSWORD_NEEDED") {
      sess.status = "awaiting_password";
      sess.expiresAt = Date.now() + SESSION_TTL_MS;
      return { ok: true, status: "awaiting_password" };
    }
    throw new Error(`驗證碼錯誤: ${e.errorMessage || e.message}`);
  }
}

async function submitPassword(deptName, password) {
  const sess = sessions.get(deptName);
  if (!sess) throw new Error("沒有進行中的登入");
  if (sess.status !== "awaiting_password") throw new Error(`當前狀態 ${sess.status}, 不接受密碼`);
  if (!password) throw new Error("2FA 密碼不能為空");

  const { client } = sess;
  try {
    // gram.js 的 signInWithPassword 處理 SRP 挑戰
    await client.signInWithPassword({ apiId: sess.apiId, apiHash: sess.apiHash }, {
      password: async () => password,
      onError: (err) => { throw err; },
    });
    return await finalizeLogin(deptName);
  } catch (e) {
    throw new Error(`2FA 密碼錯誤: ${e.errorMessage || e.message}`);
  }
}

async function finalizeLogin(deptName) {
  const sess = sessions.get(deptName);
  if (!sess) throw new Error("session 不存在");

  const sessionString = sess.client.session.save();
  const sessionPath = path.join(DEPTS_DIR, deptName, "session.txt");
  fs.writeFileSync(sessionPath, sessionString);
  console.log(`[tg-login] ✓ session.txt 寫入: ${sessionPath} (${sessionString.length} bytes)`);

  try { await sess.client.disconnect(); } catch {}
  sessions.delete(deptName);

  return { ok: true, status: "done", bytes: sessionString.length };
}

function getStatus(deptName) {
  const s = sessions.get(deptName);
  if (!s) return { status: "idle" };
  return {
    status: s.status,
    phone: s.phone,
    expiresInMs: Math.max(0, s.expiresAt - Date.now()),
  };
}

function abort(deptName) {
  const sess = sessions.get(deptName);
  if (!sess) return { ok: false, reason: "沒有進行中的登入" };
  try { sess.client?.disconnect(); } catch {}
  sessions.delete(deptName);
  return { ok: true };
}

module.exports = {
  startLogin,
  submitCode,
  submitPassword,
  getStatus,
  abort,
};
