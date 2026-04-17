// shared/worker.js
//
// v0.4 三合一 worker: listener + system-events + sheet-writer 合并成 1 个进程.
// 每部门 1 个 worker, 1 个 TG 号, 直接写 Google Sheet (不走中转群当 IPC).
//
// 兼容 v1 config (旧 listener/sheet-writer config.json) — schema migration 在读取时处理.
//
// 功能:
//   1. 监听该号加入的所有业务群 (listenMode=all-groups) 或白名单群
//   2. 命中关键字 → (a) 推中转群 (可选, 给人看) (b) 直接写关键字 Sheet
//   3. 群名变更 → (a) 推中转群 (b) 直接写群名变更 Sheet
//   4. 写 Sheet 失败 → retry 3 次, 仍失败 → 追加到 state/pending-writes.jsonl
//   5. 每 60 秒 backfill 扫最近 30 条 (防 event stream 丢)
//   6. 每 60 秒重试 pending-writes.jsonl

"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const { requireGsa } = require("./_gsa-resolver");

// ═════════════════════════════════════════════════════
// 0. 环境 / config 读取 + v1→v2 schema migration
// ═════════════════════════════════════════════════════

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error("缺少 TG_API_ID 或 TG_API_HASH (env)");
  process.exit(1);
}

if (!fs.existsSync("./session.txt")) {
  console.error("缺少 session.txt, 请先在 Web 完成 TG 登入");
  process.exit(1);
}

if (!fs.existsSync("./config.json")) {
  console.error("缺少 config.json");
  process.exit(1);
}

const GSA_PATH = requireGsa();

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync("./config.json", "utf8"));
  // v1 → v2 迁移: 把旧字段映射到新 schema
  // v1 schema: keywords/outputChatName/inputChatName/spreadsheetId/sheetName (平)
  // v2 schema: keywordSheet{id,name} + titleSheet{id,name}
  const v = raw.configVersion || 1;
  const cfg = { ...raw };
  if (!cfg.keywordSheet) {
    cfg.keywordSheet = {
      spreadsheetId: raw.spreadsheetId || "",
      sheetName: raw.sheetName || "",
      backfillIntervalMs: Number(raw.backfillIntervalMs || 60000),
      backfillLimit: Number(raw.backfillLimit || 30),
    };
  }
  if (!cfg.titleSheet) {
    // v1 里没有这个字段, v2 如果也没填就留空 (群名变更事件只推中转群, 不写表)
    cfg.titleSheet = raw.titleSheet || null;
  }
  // 默认值兜底
  cfg.listenMode = cfg.listenMode || "all-groups";
  cfg.listenChats = (cfg.listenChats || []).map(String);
  cfg.keywords = cfg.keywords || [];
  cfg.summaryMaxLength = Number(cfg.summaryMaxLength || 120);
  cfg.cooldownMs = Number(cfg.cooldownMs || 600000);
  cfg.titleEventCooldownMs = Number(cfg.titleEventCooldownMs || 60000);
  return cfg;
}

const config = loadConfig();
const outputChatName = config.outputChatName; // 中转群 (给人看的), 可选

// ═════════════════════════════════════════════════════
// 1. TG 客户端 + Google Sheets 客户端
// ═════════════════════════════════════════════════════

const sessionString = fs.readFileSync("./session.txt", "utf8").trim();
const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
  connectionRetries: 5,
});

const auth = new google.auth.GoogleAuth({
  keyFile: GSA_PATH,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ═════════════════════════════════════════════════════
// 2. 工具函数 / 去重 / 冷却
// ═════════════════════════════════════════════════════

function normalizeText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function normalizeSheetTitle(text = "") {
  return normalizeText(text).toLowerCase();
}

function shortText(text = "") {
  const cleaned = normalizeText(text);
  if (cleaned.length <= config.summaryMaxLength) return cleaned;
  return cleaned.slice(0, config.summaryMaxLength) + "...";
}

function extractPeerId(message) {
  const p = message.peerId;
  if (!p) return null;
  if (p.userId) return p.userId.toString();
  if (p.chatId) return p.chatId.toString();
  if (p.channelId) return p.channelId.toString();
  return null;
}

function matchKeywords(text = "") {
  const hit = [];
  for (const kw of config.keywords) {
    if (text.includes(kw)) hit.push(kw);
  }
  return hit;
}

// 冷却 map
const keywordCooldown = new Map(); // key: peerId::keyword → ts
const titleCooldown = new Map();   // key: peerId::marker → ts
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of keywordCooldown) if (now - ts >= config.cooldownMs) keywordCooldown.delete(k);
  for (const [k, ts] of titleCooldown) if (now - ts >= config.titleEventCooldownMs) titleCooldown.delete(k);
}, 60000).unref();

function filterKeywordsCooldown(peerId, matched) {
  const now = Date.now();
  const allowed = [], skipped = [];
  for (const kw of matched) {
    const key = `${peerId}::${kw}`;
    const last = keywordCooldown.get(key);
    if (last && now - last < config.cooldownMs) { skipped.push(kw); continue; }
    keywordCooldown.set(key, now);
    allowed.push(kw);
  }
  return { allowed, skipped };
}

function allowTitleEvent(peerId, marker) {
  const now = Date.now();
  const key = `${peerId}::${marker}`;
  const last = titleCooldown.get(key);
  if (last && now - last < config.titleEventCooldownMs) return false;
  titleCooldown.set(key, now);
  return true;
}

// 消息去重 (每小时清一次)
const dedupe = new Set();
setInterval(() => dedupe.clear(), 3600000).unref();

// ═════════════════════════════════════════════════════
// 3. Sheet 写入 (带 retry + 本地队列)
// ═════════════════════════════════════════════════════

const PENDING_FILE = path.resolve("./state/pending-writes.jsonl");
if (!fs.existsSync(path.dirname(PENDING_FILE))) {
  fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
}

function appendPending(entry) {
  fs.appendFileSync(PENDING_FILE, JSON.stringify(entry) + "\n");
  console.warn(`⚠ 写表失败已落盘 pending-writes.jsonl: ${entry.type}`);
}

let sheetMetaCache = new Map(); // spreadsheetId+sheetName → {sheetId, sheetTitle}
setInterval(() => sheetMetaCache.clear(), 3600000).unref();

async function getSheetMeta(spreadsheetId, targetSheetName) {
  const cacheKey = `${spreadsheetId}::${targetSheetName}`;
  if (sheetMetaCache.has(cacheKey)) return sheetMetaCache.get(cacheKey);
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const target = normalizeSheetTitle(targetSheetName);
  const sheet = (meta.data.sheets || []).find(
    s => normalizeSheetTitle(s.properties?.title || "") === target
  );
  if (!sheet) throw new Error(`找不到工作表: ${targetSheetName} (spreadsheetId=${spreadsheetId})`);
  const result = { sheetId: sheet.properties.sheetId, sheetTitle: sheet.properties.title };
  sheetMetaCache.set(cacheKey, result);
  return result;
}

// 关键字 Sheet: 写一行, 数据从第 3 行开始 (行 1 标题 + 行 2 表头)
async function writeKeywordRow(data) {
  const { spreadsheetId, sheetName } = config.keywordSheet || {};
  if (!spreadsheetId || !sheetName) return;

  const { sheetId, sheetTitle } = await getSheetMeta(spreadsheetId, sheetName);

  // 去重: 扫 B3:E
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${sheetTitle}!B3:E`,
  });
  const targetKey = [data.sourceGroup, data.senderName, data.keyword, data.messageContent]
    .map(normalizeText).join("||");
  for (const row of (existing.data.values || [])) {
    const rowKey = [row?.[0] || "", row?.[1] || "", row?.[2] || "", row?.[3] || ""]
      .map(normalizeText).join("||");
    if (rowKey === targetKey) {
      console.log(`跳过重复登记 -> ${data.sourceGroup} | ${data.senderName} | ${data.keyword}`);
      return;
    }
  }

  // 算序号 (A3:A 最大值 + 1)
  const noRes = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${sheetTitle}!A3:A`,
  });
  let maxNo = 0;
  for (const row of (noRes.data.values || [])) {
    const n = Number(row?.[0] || 0);
    if (!Number.isNaN(n) && n > maxNo) maxNo = n;
  }
  const nextNo = maxNo + 1;

  // 插入第 3 行 + 写入
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        insertDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: 2, endIndex: 3 },
          inheritFromBefore: false,
        },
      }],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!A3:F3`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[nextNo, data.sourceGroup, data.senderName, data.keyword, data.messageContent, data.createdAt]],
    },
  });

  console.log(`✓ keyword 已写 → #${nextNo} | ${data.sourceGroup} | ${data.keyword}`);
}

// 群名变更 Sheet: 写一行 [ , 原群名, 新群名, ...]
async function writeTitleChangeRow(data) {
  if (!config.titleSheet) return; // 没配就跳过
  const { spreadsheetId, sheetName } = config.titleSheet;
  if (!spreadsheetId || !sheetName) return;

  const { sheetId, sheetTitle } = await getSheetMeta(spreadsheetId, sheetName);

  // 去重: 扫 B3:C (原群名/新群名)
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${sheetTitle}!B3:C`,
  });
  const targetKey = [data.oldTitle, data.newTitle].map(normalizeText).join("||");
  for (const row of (existing.data.values || [])) {
    const rowKey = [row?.[0] || "", row?.[1] || ""].map(normalizeText).join("||");
    if (rowKey === targetKey) {
      console.log(`跳过重复群名变更 -> ${data.oldTitle} → ${data.newTitle}`);
      return;
    }
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        insertDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: 2, endIndex: 3 },
          inheritFromBefore: false,
        },
      }],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!B3:C3`,
    valueInputOption: "RAW",
    requestBody: { values: [[data.oldTitle, data.newTitle]] },
  });

  console.log(`✓ title 已写 → ${data.oldTitle} → ${data.newTitle}`);
}

// retry 包装器
async function writeWithRetry(type, data, attempt = 1) {
  try {
    if (type === "keyword") await writeKeywordRow(data);
    else if (type === "title") await writeTitleChangeRow(data);
  } catch (e) {
    console.error(`✗ 写 ${type} Sheet 失败 (第 ${attempt} 次): ${e.message}`);
    if (attempt >= 3) {
      appendPending({ type, data, error: e.message, ts: new Date().toISOString() });
      return;
    }
    await new Promise(r => setTimeout(r, 2000 * attempt)); // 2s, 4s 后重试
    await writeWithRetry(type, data, attempt + 1);
  }
}

// 每 60s 重跑 pending-writes.jsonl
async function retryPending() {
  if (!fs.existsSync(PENDING_FILE)) return;
  const content = fs.readFileSync(PENDING_FILE, "utf8").trim();
  if (!content) return;
  const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
  const stillPending = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "keyword") await writeKeywordRow(entry.data);
      else if (entry.type === "title") await writeTitleChangeRow(entry.data);
      console.log(`✓ pending 补写成功 (${entry.type})`);
    } catch (e) {
      stillPending.push(line);
    }
  }
  fs.writeFileSync(PENDING_FILE, stillPending.join("\n") + (stillPending.length ? "\n" : ""));
  if (stillPending.length > 0) console.log(`... 还剩 ${stillPending.length} 条 pending`);
}

// ═════════════════════════════════════════════════════
// 4. TG 事件处理
// ═════════════════════════════════════════════════════

let outputEntity = null;

async function findDialogEntityByName(name) {
  if (!name) return null;
  const dialogs = await client.getDialogs({});
  for (const d of dialogs) {
    if ((d.name || "").trim() === name) return d.entity;
  }
  return null;
}

async function getChatInfo(message, peerId) {
  try {
    const chat = await message.getChat();
    if (chat) {
      return {
        name: chat.title || chat.firstName || chat.username || peerId,
        isGroup: Boolean(chat.megagroup || chat.broadcast || chat.title),
      };
    }
  } catch {}
  return { name: peerId, isGroup: true };
}

function shouldListen(peerId, chatInfo) {
  if (!peerId || !chatInfo?.isGroup) return false;
  if (outputChatName && chatInfo.name === outputChatName) return false; // 不听中转群
  if (config.listenMode === "all-groups") return true;
  return config.listenChats.includes(peerId);
}

function extractTitleChange(message) {
  const action = message.action;
  if (action && action.className === "MessageActionChatEditTitle") return action.title || null;
  return null;
}

function isTitleChangeText(text = "") {
  return text.includes("把群组名称已更改为") || text.includes("已更改为");
}

async function handleMessage(message) {
  if (!message) return;

  const peerId = extractPeerId(message);
  if (!peerId) return;

  const chatInfo = await getChatInfo(message, peerId);
  if (!shouldListen(peerId, chatInfo)) return;

  const msgId = message.id?.toString?.() || "";
  const dedupeKey = `${peerId}:${msgId}`;
  if (dedupe.has(dedupeKey)) return;

  const sender = await message.getSender().catch(() => null);
  const operatorName =
    [sender?.firstName, sender?.lastName].filter(Boolean).join(" ") ||
    sender?.username || "UNKNOWN";

  // 分支 A: 群名变更事件 (action 类型)
  const eventTitle = extractTitleChange(message);
  if (message.className === "MessageService" && eventTitle) {
    if (!allowTitleEvent(peerId, `event::${eventTitle}`)) return;
    dedupe.add(dedupeKey);

    const output = [
      "【群名称变更提醒】",
      "",
      `来源群：${chatInfo.name}`,
      `操作人：${operatorName}`,
      `新群名：${eventTitle}`,
    ].join("\n");

    // 推中转群 (给人看)
    if (outputEntity) {
      await client.sendMessage(outputEntity, { message: output }).catch(e => console.error("推中转群失败:", e.message));
    }
    // 写 Sheet (异步 retry)
    writeWithRetry("title", { oldTitle: "", newTitle: eventTitle }).catch(() => {});
    return;
  }

  // 分支 B: 普通消息
  const text = normalizeText(message.message || "");
  if (!text) return;

  // B1: 群名变更 (文本形式, 如"把群组名称已更改为 xxx")
  if (isTitleChangeText(text)) {
    if (!allowTitleEvent(peerId, `text::${text}`)) return;
    dedupe.add(dedupeKey);
    if (outputEntity) {
      await client.sendMessage(outputEntity, {
        message: `【群名称变更提醒】\n\n来源群：${chatInfo.name}\n操作人：${operatorName}\n变更内容：\n${text}`,
      }).catch(e => console.error("推中转群失败:", e.message));
    }
    return;
  }

  // B2: 关键字命中
  const matched = matchKeywords(text);
  if (matched.length === 0) return;

  const { allowed, skipped } = filterKeywordsCooldown(peerId, matched);
  if (allowed.length === 0) return;
  if (skipped.length) console.log(`部分冷却: ${skipped.join(",")}, allowed: ${allowed.join(",")}`);

  dedupe.add(dedupeKey);

  const pushText = [
    "【群消息监听提醒】",
    "",
    `来源群：${chatInfo.name}`,
    `发送人：${operatorName}`,
    `命中关键词：${allowed.join("、")}`,
    "",
    "消息内容：",
    shortText(text),
  ].join("\n");

  // 推中转群
  if (outputEntity) {
    await client.sendMessage(outputEntity, { message: pushText }).catch(e => console.error("推中转群失败:", e.message));
  }

  // 写 keyword Sheet (每个命中一行)
  for (const kw of allowed) {
    const data = {
      sourceGroup: chatInfo.name,
      senderName: operatorName,
      keyword: kw,
      messageContent: shortText(text),
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }),
    };
    writeWithRetry("keyword", data).catch(() => {});
  }
}

// ═════════════════════════════════════════════════════
// 5. Backfill (每 60s 扫业务群最近 30 条)
// ═════════════════════════════════════════════════════

async function runBackfill() {
  try {
    const dialogs = await client.getDialogs({ limit: 200 });
    const groups = dialogs.filter(d => d.isGroup || d.isChannel);
    for (const d of groups) {
      if (outputChatName && (d.name || "").trim() === outputChatName) continue;
      if (config.listenMode === "whitelist") {
        const id = d.entity?.id?.toString?.() || d.entity?.chatId?.toString?.() || d.entity?.channelId?.toString?.();
        if (!config.listenChats.includes(id)) continue;
      }
      try {
        const limit = Number(config.keywordSheet?.backfillLimit || 30);
        const messages = await client.getMessages(d.entity, { limit });
        for (const m of (messages || []).reverse()) {
          await handleMessage(m);
        }
      } catch (e) {
        // 单个群 getMessages 失败不影响其他
      }
    }
  } catch (e) {
    console.error("backfill 报错:", e.message);
  }
}

// ═════════════════════════════════════════════════════
// 6. 启动
// ═════════════════════════════════════════════════════

(async () => {
  await client.connect();

  if (outputChatName) {
    outputEntity = await findDialogEntityByName(outputChatName);
    if (!outputEntity) {
      console.warn(`⚠ 找不到中转群 "${outputChatName}", 命中只会写 Sheet, 不推 TG (可去 config 确认群名或让本号加入该群)`);
    }
  } else {
    console.log("未配置中转群 (outputChatName), 命中只写 Sheet, 不推 TG 消息");
  }

  console.log(`[worker] 已启动`);
  console.log(`  TG 号: connected`);
  console.log(`  监听模式: ${config.listenMode}`);
  console.log(`  关键字: ${config.keywords.length} 个`);
  console.log(`  中转群: ${outputChatName || "(无)"}`);
  console.log(`  keyword Sheet: ${config.keywordSheet?.spreadsheetId ? config.keywordSheet.sheetName : "(未配)"}`);
  console.log(`  title Sheet:   ${config.titleSheet?.spreadsheetId ? config.titleSheet.sheetName : "(未配)"}`);
  console.log(`  冷却: 关键字 ${config.cooldownMs / 60000} 分钟 / 群名变更 ${config.titleEventCooldownMs / 1000} 秒`);

  client.addEventHandler(async (event) => {
    try { await handleMessage(event.message); }
    catch (e) { console.error("handleMessage 报错:", e.message || e); }
  }, new NewMessage({ incoming: true, outgoing: true }));

  // Backfill + pending retry 循环
  const backfillIntervalMs = Number(config.keywordSheet?.backfillIntervalMs || 60000);
  await runBackfill();
  setInterval(runBackfill, backfillIntervalMs).unref();
  setInterval(retryPending, 60000).unref();
})();
