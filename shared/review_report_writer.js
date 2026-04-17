require("dotenv").config();
const fs = require("fs");
const { google } = require("googleapis");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error("缺少 TG_API_ID 或 TG_API_HASH");
  process.exit(1);
}

if (!fs.existsSync("./session.txt")) {
  console.error("缺少 session.txt，请先放入 @sumu618 的可用 TG 登录态");
  process.exit(1);
}

const { requireGsa } = require("./_gsa-resolver");
const GSA_PATH = requireGsa();
if (false) {
  console.error("缺少 google-service-account.json");
  process.exit(1);
}

if (!fs.existsSync("./config.json")) {
  console.error("缺少 config.json");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const inputChatNames = (config.inputChatNames || []).map((item) => String(item).trim());
const inputChatNameSet = new Set(inputChatNames);
const spreadsheetId = config.spreadsheetId;
const sheetName = config.sheetName;
const backfillIntervalMs = Number(config.backfillIntervalMs || 60000);
const backfillLimit = Number(config.backfillLimit || 30);
const keyword = String(config.keyword || "审查报告").trim();
const resultKeyword = String(config.resultKeyword || "闭环处理结果说明").trim();
const strictMode = config.strictMode !== false;

const sessionString = fs.readFileSync("./session.txt", "utf8").trim();
const stringSession = new StringSession(sessionString);
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

const auth = new google.auth.GoogleAuth({
  keyFile: GSA_PATH,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const dedupe = new Set();
let resolvedSheetNameCache = "";
let targetChatIds = new Set();
let targetDialogsCache = [];

setInterval(() => dedupe.clear(), 3600000);
setInterval(() => {
  resolvedSheetNameCache = "";
}, 3600000);

function normalizeText(text = "") {
  return String(text).replace(/\r/g, "").trim();
}

function normalizeSheetTitle(text = "") {
  return normalizeText(text).toLowerCase();
}

function normalizeForCompare(text = "") {
  return normalizeText(text).replace(/\s+/g, " ");
}

function normalizeReviewerName(name = "") {
  const raw = normalizeText(name);
  if (!raw) return "未知发送人";

  const match = raw.match(/^[\u4e00-\u9fa5A-Za-z·]+/);
  if (match && match[0]) {
    return match[0].trim() || "未知发送人";
  }

  return raw
    .split(/[（(\-—_\s]/)[0]
    .trim() || "未知发送人";
}

function getChatIdString(entityOrChat = {}) {
  return String(
    entityOrChat?.id?.toString?.() ||
    entityOrChat?.chatId?.toString?.() ||
    entityOrChat?.channelId?.toString?.() ||
    ""
  );
}

function extractSection(raw, startLabel, endLabel) {
  const startIndex = raw.indexOf(startLabel);
  if (startIndex < 0) return "";
  const contentStart = startIndex + startLabel.length;
  const endIndex = endLabel ? raw.indexOf(endLabel, contentStart) : -1;
  const value = endIndex >= 0 ? raw.slice(contentStart, endIndex) : raw.slice(contentStart);
  return normalizeText(value);
}

function extractSingleLine(raw, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(new RegExp(`${escaped}：([^\n]+)`));
  return match ? normalizeText(match[1]) : "";
}

function shouldAcceptParsedReport(parsed) {
  const hasCoreNarrative = Boolean(parsed.issueDesc) && Boolean(parsed.initialFinding);
  const hasUsefulIdentity = Boolean(parsed.reviewNo) || Boolean(parsed.externalGroup);

  if (!strictMode) return hasCoreNarrative || hasUsefulIdentity;
  return hasCoreNarrative && hasUsefulIdentity;
}

function formatTelegramMessageTime(messageDate) {
  if (!messageDate) {
    return new Date().toLocaleString("zh-CN", {
      hour12: false,
      timeZone: "Asia/Shanghai",
    });
  }

  const dateObj = messageDate instanceof Date
    ? messageDate
    : new Date(Number(messageDate) * 1000);

  return dateObj.toLocaleString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

function parseReviewReport(text, senderName, sourceGroup, messageDate) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw || !raw.includes(keyword)) return null;

  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const title = lines.find((line) => line.includes(keyword)) || "";
  const reviewNo = extractSingleLine(raw, "编号");
  const externalGroup =
    extractSingleLine(raw, "外部广告对接群") ||
    extractSingleLine(raw, "广告对接群") ||
    extractSingleLine(raw, "外部广告对接群信息");
  const company = extractSingleLine(raw, "产品所属公司");
  const adType = extractSingleLine(raw, "广告类型");
  const advertiser = extractSingleLine(raw, "广告主");
  const businessOwner = extractSingleLine(raw, "对接商务");
  const externalOperator = extractSingleLine(raw, "对应外事号");
  const issueDesc = extractSection(raw, "问题情况说明：", "初步认定：");
  const initialFinding = extractSection(raw, "初步认定：", "");

  const parsed = {
    title,
    reviewNo,
    externalGroup,
    company,
    adType,
    advertiser,
    businessOwner,
    externalOperator,
    issueDesc,
    initialFinding,
    createdAt: formatTelegramMessageTime(messageDate),
    reviewer: senderName,
    sourceGroup,
  };

  if (!shouldAcceptParsedReport(parsed)) return null;
  return parsed;
}

function parseClosureResult(text) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw || !raw.includes(resultKeyword)) return null;

  const reviewNo = extractSingleLine(raw, "编号");
  const detail = extractSection(raw, "详情：", "");
  if (!reviewNo || !detail) return null;

  return {
    reviewNo,
    detail,
  };
}

function buildContentKey(data) {
  return [
    normalizeForCompare(data.reviewNo),
    normalizeForCompare(data.externalGroup),
    normalizeForCompare(data.company),
    normalizeForCompare(data.adType),
    normalizeForCompare(data.advertiser),
    normalizeForCompare(data.businessOwner),
    normalizeForCompare(data.externalOperator),
    normalizeForCompare(data.issueDesc),
    normalizeForCompare(data.initialFinding),
    normalizeForCompare(data.reviewer),
  ].join("||");
}

async function getSheetMeta(targetSheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const normalizedTarget = normalizeSheetTitle(targetSheetName);
  const sheet = (meta.data.sheets || []).find(
    (s) => normalizeSheetTitle(s.properties?.title || "") === normalizedTarget
  );
  if (!sheet) throw new Error(`找不到工作表：${targetSheetName}`);
  resolvedSheetNameCache = sheet.properties.title;
  return {
    sheetId: sheet.properties.sheetId,
    sheetTitle: sheet.properties.title,
  };
}

async function getResolvedSheetName() {
  if (resolvedSheetNameCache) return resolvedSheetNameCache;
  const meta = await getSheetMeta(sheetName);
  return meta.sheetTitle;
}

async function isDuplicateRecord(data) {
  const resolvedSheetName = await getResolvedSheetName();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${resolvedSheetName}!A3:K`,
  });
  const rows = res.data.values || [];
  const targetKey = buildContentKey(data);

  for (const row of rows) {
    const rowKey = buildContentKey({
      reviewNo: row?.[0] || "",
      externalGroup: row?.[1] || "",
      company: row?.[2] || "",
      adType: row?.[3] || "",
      advertiser: row?.[4] || "",
      businessOwner: row?.[5] || "",
      externalOperator: row?.[6] || "",
      issueDesc: row?.[7] || "",
      initialFinding: row?.[8] || "",
      reviewer: row?.[10] || "",
    });
    if (rowKey === targetKey) return true;
  }
  return false;
}

async function insertRowAt3AndWrite(data) {
  const { sheetId, sheetTitle } = await getSheetMeta(sheetName);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: 2,
              endIndex: 3,
            },
            inheritFromBefore: false,
          },
        },
      ],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!A3:K3`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        data.reviewNo,
        data.externalGroup,
        data.company,
        data.adType,
        data.advertiser,
        data.businessOwner,
        data.externalOperator,
        data.issueDesc,
        data.initialFinding,
        data.createdAt,
        data.reviewer,
      ]],
    },
  });
}

async function findRowByReviewNo(reviewNo) {
  const resolvedSheetName = await getResolvedSheetName();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${resolvedSheetName}!A3:A`,
  });

  const rows = res.data.values || [];
  const target = normalizeForCompare(reviewNo);
  for (let idx = 0; idx < rows.length; idx++) {
    const value = normalizeForCompare(rows[idx]?.[0] || "");
    if (value === target) {
      return idx + 3;
    }
  }
  return 0;
}

async function writeClosureDetail(reviewNo, detail) {
  const resolvedSheetName = await getResolvedSheetName();
  const row = await findRowByReviewNo(reviewNo);
  if (!row) {
    console.warn(`闭环结果未找到对应编号，跳过 -> ${reviewNo}`);
    return false;
  }

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${resolvedSheetName}!M${row}`,
  });
  const existingValue = normalizeText(existing.data.values?.[0]?.[0] || "");
  if (normalizeForCompare(existingValue) === normalizeForCompare(detail)) {
    console.log(`跳过重复闭环结果 -> ${reviewNo}`);
    return true;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${resolvedSheetName}!M${row}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[detail]],
    },
  });

  console.log(`已写入闭环结果 -> ${reviewNo}`);
  return true;
}

async function resolveTargetDialogs() {
  const dialogs = await client.getDialogs({});
  const matched = [];
  const seenIds = new Set();

  for (const expectedName of inputChatNames) {
    const candidates = dialogs.filter((dialog) => normalizeText(dialog.name || "") === expectedName);
    if (!candidates.length) {
      console.warn(`未找到监听群：${expectedName}`);
      continue;
    }

    const chosen = candidates[0];
    const chatId = getChatIdString(chosen.entity);
    if (!chatId || seenIds.has(chatId)) continue;
    seenIds.add(chatId);
    matched.push({
      chatId,
      name: expectedName,
      entity: chosen.entity,
    });

    if (candidates.length > 1) {
      console.warn(`监听群存在重名，仅取首个实体 -> ${expectedName} | 命中 ${candidates.length} 个`);
    }
  }

  targetDialogsCache = matched;
  targetChatIds = new Set(matched.map((item) => item.chatId));
  return matched;
}

async function handleMessage(message) {
  if (!message) return;

  const chat = await message.getChat().catch(() => null);
  const chatId = getChatIdString(chat);
  const chatName = normalizeText(chat?.title || chat?.firstName || "");
  if (!targetChatIds.has(chatId)) return;
  if (!inputChatNameSet.has(chatName)) return;

  const msgId = message.id?.toString?.() || "";
  const text = message.message || "";

  const closure = parseClosureResult(text);
  if (closure) {
    const closureDedupeKey = `closure:${chatId}:${msgId}`;
    if (dedupe.has(closureDedupeKey)) return;
    dedupe.add(closureDedupeKey);
    await writeClosureDetail(closure.reviewNo, closure.detail);
    return;
  }

  const dedupeKey = `${chatId}:${msgId}`;
  if (dedupe.has(dedupeKey)) return;

  const sender = await message.getSender().catch(() => null);
  const senderNameRaw = normalizeText([
    sender?.firstName,
    sender?.lastName,
  ].filter(Boolean).join(" ")) || sender?.username || "未知发送人";
  const senderName = normalizeReviewerName(senderNameRaw);

  const parsed = parseReviewReport(text, senderName, chatName, message.date);
  if (!parsed) return;

  dedupe.add(dedupeKey);

  if (await isDuplicateRecord(parsed)) {
    console.log(`跳过重复登记 -> ${parsed.reviewNo} | ${parsed.company} | ${parsed.reviewer}`);
    return;
  }

  await insertRowAt3AndWrite(parsed);
  console.log(`已写入审查报告 -> ${parsed.reviewNo} | ${parsed.company} | ${parsed.reviewer}`);
}

(async () => {
  await client.connect();

  const dialogs = await resolveTargetDialogs();
  if (!dialogs.length) {
    console.error("找不到任何监听群，请确认 @sumu618 已加入目标群且群名无误");
    process.exit(1);
  }

  console.log(`审查报告汇总写表服务已启动，固定监听群数量：${dialogs.length}，目标工作表：${sheetName}`);

  client.addEventHandler(async (event) => {
    try {
      await handleMessage(event.message);
    } catch (err) {
      console.error("审查报告写表服务报错：", err.message || err);
    }
  }, new NewMessage({ incoming: true, outgoing: false }));

  const runBackfill = async () => {
    try {
      if (!targetDialogsCache.length) {
        await resolveTargetDialogs();
      }
      for (const dialog of targetDialogsCache) {
        const messages = await client.getMessages(dialog.entity, { limit: backfillLimit });
        const list = Array.isArray(messages) ? messages : [messages];
        for (const message of list.reverse()) {
          await handleMessage(message);
        }
      }
    } catch (err) {
      console.error("审查报告补漏扫描报错：", err.message || err);
    }
  };

  await runBackfill();
  setInterval(runBackfill, backfillIntervalMs);
})();
