// web/lib/tg-dialogs.js
//
// 用已登入的 session 拉该号加入的 dialogs (群/频道) 列表, 给 Web 做下拉建议.
// 60s 内存快取 per target, 避免反复触发 TG 流控.

"use strict";

const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const ROOT = path.resolve(__dirname, "..", "..");
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // key → { at, dialogs }

function targetBaseDir(scope, name) {
  if (scope === "dept") return path.join(ROOT, "depts", name);
  if (scope === "global") return path.join(ROOT, "global", name);
  throw new Error(`unknown scope: ${scope}`);
}

function readEnv(baseDir) {
  const envPath = path.join(baseDir, ".env");
  if (!fs.existsSync(envPath)) throw new Error(".env 不存在");
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  if (!out.TG_API_ID || !out.TG_API_HASH) throw new Error(".env 缺 TG_API_ID/TG_API_HASH");
  return { apiId: Number(out.TG_API_ID), apiHash: out.TG_API_HASH };
}

async function listDialogs(scope, name) {
  const key = `${scope}:${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { cached: true, ...hit.data };
  }
  const baseDir = targetBaseDir(scope, name);
  if (!fs.existsSync(baseDir)) throw new Error(`${key} 不存在`);
  const sessionPath = path.join(baseDir, "session.txt");
  if (!fs.existsSync(sessionPath) || fs.statSync(sessionPath).size === 0) {
    throw new Error("session.txt 不存在或为空, 请先登入 TG");
  }
  const sessionStr = fs.readFileSync(sessionPath, "utf8").trim();
  const { apiId, apiHash } = readEnv(baseDir);

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 2,
    deviceModel: "shencha",
    systemVersion: "Linux",
    appVersion: "1.0",
    langCode: "zh-CN",
    systemLangCode: "zh-CN",
  });
  try {
    await client.connect();
    const dialogs = await client.getDialogs({ limit: 100 });
    const list = dialogs
      .filter(d => d.isGroup || d.isChannel)
      .map(d => ({
        title: d.title || d.name || "(无名)",
        id: String(d.id),
        type: d.isGroup ? "group" : "channel",
        unread: d.unreadCount || 0,
      }))
      .filter(d => d.title)
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
    const data = { dialogs: list, fetchedAt: new Date().toISOString() };
    cache.set(key, { at: Date.now(), data });
    return { cached: false, ...data };
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

function invalidate(scope, name) {
  cache.delete(`${scope}:${name}`);
}

module.exports = { listDialogs, invalidate };
