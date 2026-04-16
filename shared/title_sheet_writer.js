require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

if (!fs.existsSync("./config.json")) {
  console.error("缺少 config.json");
  process.exit(1);
}

if (!fs.existsSync("./google-service-account.json")) {
  console.error("缺少 google-service-account.json");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
const routes = config.routes || {};
const backfillIntervalMs = Number(config.backfillIntervalMs || 60000);
const backfillLimit = Number(config.backfillLimit || 30);

const auth = new google.auth.GoogleAuth({
  keyFile: "./google-service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const processedMessageIds = new Set();
const processedContentKeys = new Map();
const CONTENT_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;

setInterval(() => {
  processedMessageIds.clear();

  const now = Date.now();
  for (const [key, expiresAt] of processedContentKeys.entries()) {
    if (expiresAt <= now) {
      processedContentKeys.delete(key);
    }
  }
}, 60 * 60 * 1000);

function normalizeText(text = "") {
  return String(text).replace(/\r/g, "").trim();
}

function buildContentKey(chatName, oldTitle, newTitle) {
  return [
    normalizeText(chatName),
    normalizeText(oldTitle),
    normalizeText(newTitle),
  ].join("||");
}

function parseTitleReminder(text) {
  const raw = normalizeText(text);
  if (!raw.includes("【群名称变更提醒】")) return null;

  const oldMatch = raw.match(/原群名：([^\n]+)/);
  const newMatch = raw.match(/新群名：([^\n]+)/);

  if (!oldMatch || !newMatch) return null;

  return {
    oldTitle: oldMatch[1].trim(),
    newTitle: newMatch[1].trim(),
  };
}

function extractSpreadsheetId(urlOrId) {
  const str = String(urlOrId || "").trim();
  const m = str.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : str;
}

async function getSheetMeta(spreadsheetId, targetSheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties?.title === targetSheetName
  );

  if (!sheet) {
    throw new Error(`找不到工作表：${targetSheetName}`);
  }

  return {
    sheetId: sheet.properties.sheetId,
    columnCount: sheet.properties?.gridProperties?.columnCount || 26,
  };
}

async function getAllRows(spreadsheetId, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:F`,
  });
  return res.data.values || [];
}

function analyzeExistingRows(rows, oldTitle, newTitle) {
  const normalizedOld = normalizeText(oldTitle);
  const normalizedNew = normalizeText(newTitle);

  let exactDuplicate = null;
  let chainMatch = null;
  let oldTitleMatch = null;
  let newTitleRelated = null;

  for (let i = 4; i < rows.length; i++) {
    const row = rows[i] || [];
    const b = normalizeText(row[1] || "");
    const c = normalizeText(row[2] || "");
    const info = {
      rowIndex: i + 1,
      oldCell: b,
      newCell: c,
    };

    if (b === normalizedOld && c === normalizedNew) {
      exactDuplicate = info;
      break;
    }

    if (!chainMatch && c === normalizedOld) {
      chainMatch = info;
      continue;
    }

    if (!oldTitleMatch && (b === normalizedOld || c === normalizedOld)) {
      oldTitleMatch = info;
      continue;
    }

    if (!newTitleRelated && (b === normalizedNew || c === normalizedNew)) {
      newTitleRelated = info;
    }
  }

  if (exactDuplicate) {
    return { type: "duplicate", rowIndex: exactDuplicate.rowIndex };
  }

  if (chainMatch) {
    return { type: "match", rowIndex: chainMatch.rowIndex, reason: "chain" };
  }

  if (oldTitleMatch) {
    return { type: "match", rowIndex: oldTitleMatch.rowIndex, reason: "old-title" };
  }

  if (newTitleRelated) {
    return { type: "match", rowIndex: newTitleRelated.rowIndex, reason: "new-title-related" };
  }

  return null;
}

async function moveRowToTop(spreadsheetId, sheetName, rowIndex, oldTitle, newTitle) {
  const { sheetId, columnCount } = await getSheetMeta(spreadsheetId, sheetName);

  if (rowIndex !== 5) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            cutPaste: {
              source: {
                sheetId,
                startRowIndex: rowIndex - 1,
                endRowIndex: rowIndex,
                startColumnIndex: 0,
                endColumnIndex: columnCount,
              },
              destination: {
                sheetId,
                rowIndex: 4,
                columnIndex: 0,
              },
              pasteType: "PASTE_NORMAL",
            },
          },
        ],
      },
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!B5:C5`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[oldTitle, newTitle]],
    },
  });
}

async function insertNewRowAt5(spreadsheetId, sheetName, oldTitle, newTitle) {
  const { sheetId } = await getSheetMeta(spreadsheetId, sheetName);

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
    range: `${sheetName}!B5:C5`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[oldTitle, newTitle]],
    },
  });
}

async function processTitleChange(instanceName, chatName, message) {
  const route = routes[chatName];
  if (!route) return;

  const parsed = parseTitleReminder(message.message || "");
  if (!parsed) return;

  const spreadsheetId = extractSpreadsheetId(route.spreadsheetId);
  const sheetName = route.sheetName;
  const messageId = message.id?.toString?.() || "";
  const messageKey = `${chatName}:${messageId}`;
  const contentKey = buildContentKey(chatName, parsed.oldTitle, parsed.newTitle);

  if (processedMessageIds.has(messageKey)) return;
  processedMessageIds.add(messageKey);

  const now = Date.now();
  const contentExpiresAt = processedContentKeys.get(contentKey) || 0;
  if (contentExpiresAt > now) {
    console.log(`跳过内容级重复 -> ${chatName} | ${parsed.oldTitle} => ${parsed.newTitle}`);
    return;
  }

  const rows = await getAllRows(spreadsheetId, sheetName);
  const existing = analyzeExistingRows(rows, parsed.oldTitle, parsed.newTitle);

  if (existing?.type === "duplicate") {
    processedContentKeys.set(contentKey, now + CONTENT_DEDUPE_TTL_MS);
    console.log(`跳过重复群名变更 -> ${chatName} | ${parsed.oldTitle} => ${parsed.newTitle}`);
    return;
  }

  if (existing?.type === "match") {
    await moveRowToTop(
      spreadsheetId,
      sheetName,
      existing.rowIndex,
      parsed.oldTitle,
      parsed.newTitle
    );
    processedContentKeys.set(contentKey, now + CONTENT_DEDUPE_TTL_MS);
    console.log(`已更新群名并移到第5行 -> ${chatName} | ${parsed.oldTitle} => ${parsed.newTitle}`);
    return;
  }

  await insertNewRowAt5(
    spreadsheetId,
    sheetName,
    parsed.oldTitle,
    parsed.newTitle
  );

  processedContentKeys.set(contentKey, now + CONTENT_DEDUPE_TTL_MS);
  console.log(`已新增群名记录 -> ${chatName} | ${parsed.oldTitle} => ${parsed.newTitle}`);
}

async function createClient(instanceName) {
  const baseDir = `/root/tg-system-services/${instanceName}`;
  const envPath = path.join(baseDir, ".env");
  const sessionPath = path.join(baseDir, "session.txt");

  if (!fs.existsSync(envPath)) {
    throw new Error(`${instanceName} 缺少 .env`);
  }

  if (!fs.existsSync(sessionPath)) {
    throw new Error(`${instanceName} 缺少 session.txt`);
  }

  const envText = fs.readFileSync(envPath, "utf8");
  const apiIdMatch = envText.match(/TG_API_ID=(.+)/);
  const apiHashMatch = envText.match(/TG_API_HASH=(.+)/);

  const instanceApiId = Number(apiIdMatch?.[1]?.trim());
  const instanceApiHash = apiHashMatch?.[1]?.trim();

  if (!instanceApiId || !instanceApiHash) {
    throw new Error(`${instanceName} 的 .env 缺少 TG_API_ID 或 TG_API_HASH`);
  }

  const sessionString = fs.readFileSync(sessionPath, "utf8").trim();
  const client = new TelegramClient(
    new StringSession(sessionString),
    instanceApiId,
    instanceApiHash,
    { connectionRetries: 5 }
  );

  await client.connect();
  return client;
}

(async () => {
  const instances = [...new Set(Object.values(routes).map((r) => r.instance))];

  for (const instanceName of instances) {
    const client = await createClient(instanceName);

    console.log(`群名称变更写表服务已连接实例：${instanceName}`);

    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message || typeof message.getChat !== "function") return;

        const chat = await message.getChat().catch(() => null);
        const chatName = chat?.title || chat?.firstName || "";
        if (!routes[chatName]) return;

        await processTitleChange(instanceName, chatName, message);
      } catch (err) {
        console.error(`实例 ${instanceName} 写表报错：`, err.message || err);
      }
    }, new NewMessage({ incoming: true, outgoing: false }));

    const dialogs = await client.getDialogs({});

    const runBackfill = async () => {
      try {
        for (const [chatName, route] of Object.entries(routes)) {
          if (route.instance !== instanceName) continue;

          const dialog = dialogs.find((d) => (d.name || "").trim() === chatName);
          if (!dialog) continue;

          const messages = await client.getMessages(dialog.entity, { limit: backfillLimit });
          const list = Array.isArray(messages) ? messages : [messages];
          for (const message of list.reverse()) {
            await processTitleChange(instanceName, chatName, message);
          }
        }
      } catch (err) {
        console.error(`实例 ${instanceName} 补漏扫描报错：`, err.message || err);
      }
    };

    await runBackfill();
    setInterval(runBackfill, backfillIntervalMs);
  }

  console.log("群名称变更写表服务已启动");
})();
