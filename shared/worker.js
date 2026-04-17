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

// 群名缓存 (peerId → 当前群名), 持久化在 state/title-cache.json
// TG 的改名事件只带新名, 原名靠这个缓存对照
const TITLE_CACHE_FILE = path.resolve("./state/title-cache.json");
let titleCache = {};
try {
  if (fs.existsSync(TITLE_CACHE_FILE)) titleCache = JSON.parse(fs.readFileSync(TITLE_CACHE_FILE, "utf8")) || {};
} catch {}
function saveTitleCache() {
  try {
    if (!fs.existsSync(path.dirname(TITLE_CACHE_FILE))) fs.mkdirSync(path.dirname(TITLE_CACHE_FILE), { recursive: true });
    fs.writeFileSync(TITLE_CACHE_FILE, JSON.stringify(titleCache, null, 2));
  } catch {}
}
async function primeTitleCache() {
  try {
    const dialogs = await client.getDialogs({ limit: 200 });
    for (const d of dialogs) {
      if (!d.isGroup && !d.isChannel) continue;
      const id = d.entity?.id?.toString?.() || d.entity?.chatId?.toString?.() || d.entity?.channelId?.toString?.();
      if (!id) continue;
      const name = (d.name || "").trim();
      if (!name) continue;
      // 缓存当前群名 (后续改名事件拿这个做"原群名")
      titleCache[id] = name;
    }
    saveTitleCache();
    console.log(`[title-cache] primed ${Object.keys(titleCache).length} groups`);
  } catch (e) { console.warn("primeTitleCache:", e.message); }
}

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 表头 → 字段智能识别 (用户 Sheet 里随便写什么表头, 按模式猜意图)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 规则顺序 = 优先级 (更具体的规则放前面, 通用的放后面)
const FIELD_RULES = [
  // ── ID 类 (必须在通用"id"之前) ──
  { field: "sourceGroupId",   re: /(群|来源|source|chat|group).{0,3}(id)|groupid/i },
  { field: "messageId",       re: /(消息|msg|message).{0,3}id/i },

  // ── 时间细分 (发送时间 / 消息时间 优先于通用时间) ──
  { field: "messageDate",     re: /(消息|发送|发言|发出|message|send|sent).{0,3}(时间|日期|time|date)/i },

  // ── 群名变更 ──
  { field: "oldTitle",        re: /(原|旧|改前|之前|before|prev|previous|old).{0,3}(群名|名称|标题|名字|title|name)|^原群|^旧群|^(原名|旧名|改前)$/i },
  { field: "newTitle",        re: /(新|改后|之后|after|current|new).{0,3}(群名|名称|标题|名字|title|name)|^新群|变更[后为]|改为|^(新名|改后)$/i },

  // ── 关键字 ──
  { field: "keyword",         re: /(命中)?关键[字词]|触发词|匹配|命中|keyword|hit|matched?/i },

  // ── 消息内容 ──
  { field: "messageContent",  re: /(消息|原|发言)?(内容|正文|详情|原文|文本)|(message|msg).{0,3}(content|text|body)|content|text|body/i },

  // ── 人员 ──
  { field: "senderName",      re: /(发送|发言|操作|执行|审查|登记|创建|create)?(人|者|员|方|用户|user)|operator|sender|author|by$|谁|operator/i },

  // ── 来源群 ──
  { field: "sourceGroup",     re: /(来源|所在|原|出处)?(群|频道|会话|chat|channel|group)(名|名称|title|name)?|source|来自/i },

  // ── 登记时间 (通用时间, 放最后) ──
  { field: "createdAt",       re: /(登记|记录|变更|改名|创建|发生|create|record|change|update|register)?(时间|日期|时刻|time|date|at$|when|timestamp)|datetime/i },

  // ── 序号 (通用, 放最后) ──
  { field: "serialNo",        re: /^(编号|序号|序號|流水号?|序列号?|id|#|no\.?|number|index|idx)$|(编|序|流水)号/i },
];

function matchField(header) {
  const h = String(header || "").trim();
  if (!h) return null;
  for (const rule of FIELD_RULES) {
    if (rule.re.test(h)) return rule.field;
  }
  return null; // 识别不了, 该列不写值
}

// 读 Sheet 实际表头 → 自动识别每列 field (60s 缓存)
const columnsCache = new Map(); // `${spreadsheetId}::${sheetName}` → {columns, at}
const COL_CACHE_TTL = 60 * 1000;

async function getColumnsFromSheet(spreadsheetId, sheetName) {
  const key = `${spreadsheetId}::${sheetName}`;
  const hit = columnsCache.get(key);
  if (hit && Date.now() - hit.at < COL_CACHE_TTL) return hit.columns;

  const { sheetTitle } = await getSheetMeta(spreadsheetId, sheetName);
  // 读表头行 (row 2)
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${sheetTitle}!A2:Z2`,
  });
  const headers = (r.data.values && r.data.values[0]) || [];
  const columns = headers.map(h => {
    const hStr = String(h || "").trim();
    return {
      header: hStr,
      field: matchField(hStr), // null = 没识别出来
    };
  });
  columnsCache.set(key, { columns, at: Date.now() });
  return columns;
}

// 把 data 对象按 columns 顺序展开成 row (一个数组)
function buildRow(columns, data) {
  return columns.map(c => {
    const v = data[c.field];
    return v === undefined || v === null ? "" : v;
  });
}

// 列号 idx → A1 notation 字母
function colLetter(idx) {
  let n = idx;
  let s = "";
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// 找 columns 里 serialNo 字段所在列 (算序号用)
function findSerialCol(columns) {
  return columns.findIndex(c => c.field === "serialNo");
}

// 关键字 Sheet: 从 Sheet 实际表头动态识别列
async function writeKeywordRow(data) {
  const { spreadsheetId, sheetName } = config.keywordSheet || {};
  if (!spreadsheetId || !sheetName) return;

  const columns = await getColumnsFromSheet(spreadsheetId, sheetName);
  if (columns.length === 0) { console.warn("keyword Sheet 表头为空, 跳过写入"); return; }
  const { sheetId, sheetTitle } = await getSheetMeta(spreadsheetId, sheetName);
  const lastColLetter = colLetter(columns.length - 1);

  // 去重 key: 取 sourceGroup + senderName + keyword + messageContent (只要这 4 个在列里, 按列值 combine)
  const dedupeFields = ["sourceGroup", "senderName", "keyword", "messageContent"];
  const dedupeCols = dedupeFields
    .map(f => columns.findIndex(c => c.field === f))
    .filter(i => i >= 0);

  if (dedupeCols.length > 0) {
    const firstC = colLetter(Math.min(...dedupeCols));
    const lastC  = colLetter(Math.max(...dedupeCols));
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${sheetTitle}!${firstC}3:${lastC}`,
    });
    const offset = Math.min(...dedupeCols);
    const targetVals = dedupeCols.map(ci => normalizeText(data[columns[ci].field] || ""));
    const targetKey = targetVals.join("||");
    for (const row of (existing.data.values || [])) {
      const rowVals = dedupeCols.map(ci => normalizeText(row[ci - offset] || ""));
      if (rowVals.join("||") === targetKey) {
        console.log(`跳过重复登记 -> ${data.sourceGroup} | ${data.keyword}`);
        return;
      }
    }
  }

  // 算序号 (如果有 serialNo 列)
  const serialIdx = findSerialCol(columns);
  if (serialIdx >= 0) {
    const sc = colLetter(serialIdx);
    const noRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetTitle}!${sc}3:${sc}` });
    let maxNo = 0;
    for (const row of (noRes.data.values || [])) {
      const n = Number(row?.[0] || 0);
      if (!Number.isNaN(n) && n > maxNo) maxNo = n;
    }
    data.serialNo = maxNo + 1;
  }

  // 插入第 3 行
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: 2, endIndex: 3 }, inheritFromBefore: false } }],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!A3:${lastColLetter}3`,
    valueInputOption: "RAW",
    requestBody: { values: [buildRow(columns, data)] },
  });

  console.log(`✓ keyword 已写 → #${data.serialNo || "?"} | ${data.sourceGroup} | ${data.keyword}`);
}

// 群名变更 Sheet: 写一行 [ , 原群名, 新群名, ...]
async function writeTitleChangeRow(data) {
  if (!config.titleSheet) return; // 没配就跳过
  const { spreadsheetId, sheetName } = config.titleSheet;
  if (!spreadsheetId || !sheetName) return;

  const columns = await getColumnsFromSheet(spreadsheetId, sheetName);
  if (columns.length === 0) { console.warn("title Sheet 表头为空, 跳过写入"); return; }
  const { sheetId, sheetTitle } = await getSheetMeta(spreadsheetId, sheetName);
  const lastColLetter = colLetter(columns.length - 1);

  // 去重: oldTitle + newTitle
  const oldIdx = columns.findIndex(c => c.field === "oldTitle");
  const newIdx = columns.findIndex(c => c.field === "newTitle");
  if (oldIdx >= 0 && newIdx >= 0) {
    const a = colLetter(Math.min(oldIdx, newIdx));
    const b = colLetter(Math.max(oldIdx, newIdx));
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetTitle}!${a}3:${b}` });
    const tKey = normalizeText(data.oldTitle || "") + "||" + normalizeText(data.newTitle || "");
    const offset = Math.min(oldIdx, newIdx);
    for (const row of (existing.data.values || [])) {
      const rKey = normalizeText(row[oldIdx - offset] || "") + "||" + normalizeText(row[newIdx - offset] || "");
      if (rKey === tKey) { console.log(`跳过重复群名变更`); return; }
    }
  }

  // serial
  const serialIdx = findSerialCol(columns);
  if (serialIdx >= 0) {
    const sc = colLetter(serialIdx);
    const noRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetTitle}!${sc}3:${sc}` });
    let maxNo = 0;
    for (const row of (noRes.data.values || [])) {
      const n = Number(row?.[0] || 0);
      if (!Number.isNaN(n) && n > maxNo) maxNo = n;
    }
    data.serialNo = maxNo + 1;
  }

  // 默认 createdAt
  if (!data.createdAt) data.createdAt = new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: 2, endIndex: 3 }, inheritFromBefore: false } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!A3:${lastColLetter}3`,
    valueInputOption: "RAW",
    requestBody: { values: [buildRow(columns, data)] },
  });

  console.log(`✓ title 已写 → ${data.oldTitle} → ${data.newTitle}`);
}

// 串行队列: Sheet 写入必须一个接一个 (并发 insertDimension + update 会 race → 空行/覆盖)
let sheetWriteQueue = Promise.resolve();
function enqueueSheetWrite(fn) {
  const p = sheetWriteQueue.then(() => fn()).catch(e => {
    console.error("[sheet-queue] 任务失败:", e.message);
  });
  // 不要让错误阻塞后续任务
  sheetWriteQueue = p.catch(() => {});
  return p;
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

  // 提取操作人名字 — 多条 fallback 路径
  let operatorName = "UNKNOWN";
  try {
    const sender = await message.getSender().catch(() => null);
    if (sender) {
      operatorName =
        [sender.firstName, sender.lastName].filter(Boolean).join(" ") ||
        sender.username ||
        sender.title ||  // channel (匿名管理员) 会返回 channel, title 是群名
        "UNKNOWN";
    }
    // 还是 UNKNOWN? 试 message.fromId
    if (operatorName === "UNKNOWN" && message.fromId?.userId) {
      try {
        const entity = await client.getEntity(message.fromId).catch(() => null);
        if (entity) {
          operatorName =
            [entity.firstName, entity.lastName].filter(Boolean).join(" ") ||
            entity.username ||
            operatorName;
        }
      } catch {}
    }
    // 还是 UNKNOWN → 可能是匿名管理员
    if (operatorName === "UNKNOWN") operatorName = "匿名管理员";
  } catch {}

  // 分支 A: 群名变更事件 (action 类型)
  const eventTitle = extractTitleChange(message);
  if (message.className === "MessageService" && eventTitle) {
    if (!allowTitleEvent(peerId, `event::${eventTitle}`)) return;
    dedupe.add(dedupeKey);

    // 从缓存取原群名 (TG event 只带新名, 原名靠本地 titleCache)
    const oldTitle = titleCache[peerId] || chatInfo.name || "(未知)";
    titleCache[peerId] = eventTitle;
    saveTitleCache();

    const output = [
      "【群名称变更提醒】",
      "",
      `原群名：${oldTitle}`,
      `新群名：${eventTitle}`,
      `操作人：${operatorName}`,
    ].join("\n");

    // 推中转群 (给人看)
    if (outputEntity) {
      await client.sendMessage(outputEntity, { message: output }).catch(e => console.error("推中转群失败:", e.message));
    }
    // 写 Sheet (异步 retry)
    enqueueSheetWrite(() => writeWithRetry("title", {
      oldTitle, newTitle: eventTitle,
      senderName: operatorName,
      sourceGroup: eventTitle, // 新群名 = 当前群名
      sourceGroupId: peerId,
    }));
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

  // 写 keyword Sheet (每个命中一行) — Sheet 里存完整消息, 不截断
  for (const kw of allowed) {
    const data = {
      sourceGroup: chatInfo.name,
      sourceGroupId: peerId,
      senderName: operatorName,
      keyword: kw,
      messageContent: normalizeText(text),  // 完整消息 (中转群推送用的 shortText 只影响 TG 不影响 Sheet)
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }),
      messageDate: message.date ? new Date(message.date * 1000).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "",
      messageId: message.id?.toString?.() || "",
    };
    enqueueSheetWrite(() => writeWithRetry("keyword", data));
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

  // 首次启动: 扫所有群把当前名字缓存, 后续改名才能显示原名
  await primeTitleCache();
  // 每 30 分钟刷新一次 (漏掉的新群 / 改名补齐)
  setInterval(() => primeTitleCache().catch(() => {}), 30 * 60 * 1000).unref();

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
