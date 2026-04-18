// web/lib/auth.js
//
// 管理员认证模块:
//   - bcrypt 密码 hash + verify
//   - IP 失败锁定 (5 次 / 15 分钟)
//   - 签名 cookie session (HMAC, 不用外部 session store)
//   - requireLogin middleware
//
// system.json 新增字段:
//   adminUsername        — 用户名
//   adminPasswordHash    — bcrypt hash (取代旧的明文 adminPassword)
//   sessionSecret        — HMAC 密钥 (32 字节 hex, 首启自动生成)
//   adminTgUserId        — 管理员 TG user id (绑定后填, 用于 forgot password DM)

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT, "data");
const SYSTEM_JSON = path.join(DATA_DIR, "system.json");

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 min
const ATTEMPT_WINDOW_MS = 30 * 60 * 1000;
const COOKIE_NAME = "tg_multi_auth";
const COOKIE_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 7 天

// ─── system.json 读写 ─────────────────────────────
function readSystem() {
  try { return JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")); } catch { return {}; }
}
function writeSystem(sys) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SYSTEM_JSON, JSON.stringify(sys, null, 2));
}

// ─── 密码 hash / verify ───────────────────────────
function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), 10);
}
function verifyPassword(plain, hash) {
  if (!hash) return false;
  try { return bcrypt.compareSync(String(plain), String(hash)); }
  catch { return false; }
}

// ─── session secret (HMAC 密钥) ───────────────────
function getSessionSecret() {
  const sys = readSystem();
  if (sys.sessionSecret && typeof sys.sessionSecret === "string" && sys.sessionSecret.length >= 32) {
    return sys.sessionSecret;
  }
  const s = crypto.randomBytes(32).toString("hex");
  sys.sessionSecret = s;
  writeSystem(sys);
  return s;
}

// ─── 签名 cookie ──────────────────────────────────
function sign(value) {
  const hmac = crypto.createHmac("sha256", getSessionSecret()).update(value).digest("base64url");
  return `${value}.${hmac}`;
}
function verifySigned(signed) {
  if (typeof signed !== "string" || !signed.includes(".")) return null;
  const idx = signed.lastIndexOf(".");
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = crypto.createHmac("sha256", getSessionSecret()).update(value).digest("base64url");
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return value;
}

function setAuthCookie(res, username) {
  const payload = Buffer.from(JSON.stringify({ u: username, t: Date.now() })).toString("base64url");
  res.cookie(COOKIE_NAME, sign(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // 由 Caddy 前面 HTTPS, 这里不强制 (容器内还是 HTTP)
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/",
  });
}
function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}
function getCurrentUser(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  const value = verifySigned(raw);
  if (!value) return null;
  try {
    const { u, t } = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!u || !t) return null;
    if (Date.now() - t > COOKIE_MAX_AGE_MS) return null;
    return { username: u, loginAt: t };
  } catch { return null; }
}

// ─── IP 失败锁定 (内存) ────────────────────────────
// attempts: { "<ip>": [ts1, ts2, ...] } (失败时戳, 只保留 ATTEMPT_WINDOW_MS 内)
// locks:    { "<ip>": unlockTs }
const attempts = new Map();
const locks = new Map();

function _now() { return Date.now(); }
function _cleanup(ip) {
  const arr = attempts.get(ip) || [];
  const fresh = arr.filter(t => _now() - t < ATTEMPT_WINDOW_MS);
  if (fresh.length) attempts.set(ip, fresh); else attempts.delete(ip);
  return fresh;
}

function lockoutRemainingMs(ip) {
  const until = locks.get(ip);
  if (!until) return 0;
  const left = until - _now();
  if (left <= 0) { locks.delete(ip); return 0; }
  return left;
}

function recordLoginAttempt(ip, ok) {
  if (ok) {
    attempts.delete(ip);
    locks.delete(ip);
    return;
  }
  const arr = _cleanup(ip);
  arr.push(_now());
  attempts.set(ip, arr);
  if (arr.length >= MAX_ATTEMPTS) {
    locks.set(ip, _now() + LOCKOUT_MS);
  }
}

function failuresInWindow(ip) {
  return _cleanup(ip).length;
}

// ─── middleware ───────────────────────────────────
// 白名单路径 — 不需要登入. 其他路径若无 session 就跳 /login
const PUBLIC_PREFIXES = [
  "/login",
  "/logout",
  "/setup",
  "/forgot-password",
  "/api/auth/forgot_password",
  "/api/auth/reset_password",
  "/api/v1/metrics",       // Bearer token 自己验, 不走 session
  "/health",
  "/healthz",
  "/css/", "/js/", "/img/", "/static/",
];

function isPublic(pathUrl) {
  return PUBLIC_PREFIXES.some(p => pathUrl === p || pathUrl.startsWith(p + (p.endsWith("/") ? "" : "")) || pathUrl.startsWith(p + "/"));
}

function isSetupComplete() {
  const sys = readSystem();
  return !!(sys.adminUsername && sys.adminPasswordHash);
}

function requireLogin(req, res, next) {
  // Setup 未完成: 只允许 /setup + /api/v1/metrics + 静态
  if (!isSetupComplete()) {
    if (req.path === "/" || req.path === "/login") return res.redirect("/setup");
    if (isPublic(req.path) || req.path.startsWith("/setup")) return next();
    return res.redirect("/setup");
  }

  // 公开路径直接放行
  if (isPublic(req.path)) return next();

  // 有效 session 放行
  const user = getCurrentUser(req);
  if (user) {
    req.user = user;
    return next();
  }

  // API 请求返 401 JSON
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  // HTML 请求跳 /login
  return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl || "/dashboard"));
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || req.ip || req.connection?.remoteAddress || "")
    .toString().split(",")[0].trim();
}

module.exports = {
  hashPassword, verifyPassword,
  setAuthCookie, clearAuthCookie, getCurrentUser,
  recordLoginAttempt, lockoutRemainingMs, failuresInWindow,
  requireLogin, isPublic, isSetupComplete,
  clientIp,
  MAX_ATTEMPTS, LOCKOUT_MS,
};
