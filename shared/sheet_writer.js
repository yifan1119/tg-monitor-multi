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
  console.error("缺少 session.txt，请先放入可用 TG 登录态");
  process.exit(1);
}

if (!fs.existsSync("./google-service-account.json")) {
  console.error("缺少 google-service-account.json");
  process.exit(1);
}

if (!fs.existsSync("./config.json")) {
  console.error("缺少 config.json");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const inputChatName = config.inputChatName;
const spreadsheetId = config.spreadsheetId;
const sheetName = config.sheetName;
const backfillIntervalMs = Number(config.backfillIntervalMs || 60000);
const backfillLimit = Number(config.backfillLimit || 30);

const sessionString = fs.readFileSync("./session.txt", "utf8").trim();
const stringSession = new StringSession(sessionString);

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

const auth = new google.auth.GoogleAuth({
  keyFile: "./google-service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });
const dedupe = new Set();
let resolvedSheetNameCache = "";

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

function parseReminderMessage(text) {
  const raw = normalizeText(text);
  if (!raw.includes("【群消息监听提醒】")) return null;

  const sourceMatch = raw.match(/来源群：([^\n]+)/);
  const senderMatch = raw.match(/发送人：([^\n]+)/);
  const keywordMatch = raw.match(/命中关键词：([^\n]+)/);
  const contentMatch = raw.match(/消息内容：\n([\s\S]*)$/);

  return {
    sourceGroup: sourceMatch ? sourceMatch[1].trim() : "",
    senderName: senderMatch ? senderMatch[1].trim() : "",
    keyword: keywordMatch ? keywordMatch[1].trim() : "",
    messageContent: contentMatch ? contentMatch[1].trim() : "",
    createdAt: new Date().toLocaleString("zh-CN", {
      hour12: false,
      timeZone: "Asia/Shanghai",
    }),
  };
}

function buildContentKey(data) {
  return [
    normalizeText(data.sourceGroup),
    normalizeText(data.senderName),
    normalizeText(data.keyword),
    normalizeText(data.messageContent),
  ].join("||");
}

async function findDialogByName(name) {
  const dialogs = await client.getDialogs({});
  for (const dialog of dialogs) {
    if ((dialog.name || "").trim() === name) return dialog;
  }
  return null;
}

async function getSheetMeta(targetSheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const normalizedTarget = normalizeSheetTitle(targetSheetName);
  const sheet = (meta.data.sheets || []).find(
    (s) => normalizeSheetTitle(s.properties?.title || "") === normalizedTarget
  );

  if (!sheet) {
    throw new Error(`找不到工作表：${targetSheetName}`);
  }

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

async function getNextSerialNumber() {
  const resolvedSheetName = await getResolvedSheetName();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${resolvedSheetName}!A5:A`,
  });

  const rows = res.data.values || [];
  let maxNo = 0;

  for (const row of rows) {
    const value = Number(row?.[0] || 0);
    if (!Number.isNaN(value) && value > maxNo) {
      maxNo = value;
    }
  }

  return maxNo + 1;
}

async function isDuplicateRecord(data) {
  const resolvedSheetName = await getResolvedSheetName();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${resolvedSheetName}!B5:E`,
  });

  const rows = res.data.values || [];
  const targetKey = buildContentKey(data);

  for (const row of rows) {
    const rowKey = buildContentKey({
      sourceGroup: row?.[0] || "",
      senderName: row?.[1] || "",
      keyword: row?.[2] || "",
      messageContent: row?.[3] || "",
    });
    if (rowKey === targetKey) return true;
  }

  return false;
}

async function insertRowAt5AndWrite(data) {
  const { sheetId, sheetTitle } = await getSheetMeta(sheetName);
  const nextNo = await getNextSerialNumber();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: 4,
              endIndex: 5,
            },
            inheritFromBefore: false,
          },
        },
      ],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!A5:F5`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        nextNo,
        data.sourceGroup,
        data.senderName,
        data.keyword,
        data.messageContent,
        data.createdAt,
      ]],
    },
  });

  return nextNo;
}

async function handleMessage(message, expectedChatName) {
  if (!message) return;

  const chat = await message.getChat().catch(() => null);
  const chatName = chat?.title || chat?.firstName || "";
  if (chatName !== expectedChatName) return;

  const msgId = message.id?.toString?.() || "";
  const dedupeKey = `${chatName}:${msgId}`;
  if (dedupe.has(dedupeKey)) return;

  const text = message.message || "";
  const parsed = parseReminderMessage(text);
  if (!parsed) return;

  dedupe.add(dedupeKey);

  if (await isDuplicateRecord(parsed)) {
    console.log(`跳过重复登记 -> ${parsed.sourceGroup} | ${parsed.senderName} | ${parsed.keyword}`);
    return;
  }

  const serialNo = await insertRowAt5AndWrite(parsed);
  console.log(`已写入表格 -> 编号${serialNo} | ${parsed.sourceGroup} | ${parsed.senderName} | ${parsed.keyword}`);
}

(async () => {
  await client.connect();

  const inputDialog = await findDialogByName(inputChatName);
  if (!inputDialog) {
    console.error(`找不到监听群：${inputChatName}`);
    process.exit(1);
  }

  console.log(`关键词提醒写表服务已启动，监听群：${inputChatName}，目标工作表：${sheetName}`);
  console.log(`补漏模式已开启：每 ${Math.floor(backfillIntervalMs / 1000)} 秒补扫最近 ${backfillLimit} 条消息`);

  client.addEventHandler(async (event) => {
    try {
      await handleMessage(event.message, inputChatName);
    } catch (err) {
      console.error("写表服务报错：", err.message || err);
    }
  }, new NewMessage({ incoming: true, outgoing: false }));

  const runBackfill = async () => {
    try {
      const dialog = await findDialogByName(inputChatName);
      if (!dialog) return;
      const messages = await client.getMessages(dialog.entity, { limit: backfillLimit });
      const list = Array.isArray(messages) ? messages : [messages];
      for (const message of list.reverse()) {
        await handleMessage(message, inputChatName);
      }
    } catch (err) {
      console.error("补漏扫描报错：", err.message || err);
    }
  };

  await runBackfill();
  setInterval(runBackfill, backfillIntervalMs);
})();
