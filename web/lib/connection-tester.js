// web/lib/connection-tester.js
//
// Google SA / Sheet 写入连线测试 (配置对错立刻知道).

"use strict";

const fs = require("fs");
const path = require("path");
const { translate } = require("./error-translator");

const ROOT = path.resolve(__dirname, "..", "..");
const GSA_PATH = path.join(ROOT, "shared", "google-service-account.json");

function loadGsa() {
  if (!fs.existsSync(GSA_PATH)) throw new Error("google-service-account.json 不存在 (到 /setup 上传)");
  const raw = fs.readFileSync(GSA_PATH, "utf8");
  const sa = JSON.parse(raw);
  if (!sa.client_email || !sa.private_key) throw new Error("SA JSON 结构不对, 缺少 client_email / private_key");
  return sa;
}

async function getAuth() {
  const { google } = require("googleapis");
  const sa = loadGsa();
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ],
  });
  await auth.authorize();
  return { auth, sa };
}

async function testGsa() {
  try {
    const { auth, sa } = await getAuth();
    const { google } = require("googleapis");
    // 一个简单的只读调用: drive.about.get
    const drive = google.drive({ version: "v3", auth });
    const about = await drive.about.get({ fields: "user(emailAddress)" });
    return {
      ok: true,
      email: sa.client_email,
      connectedAs: about.data.user?.emailAddress || sa.client_email,
      projectId: sa.project_id,
    };
  } catch (e) {
    return { ok: false, error: translate(e) };
  }
}

async function testSheetWrite({ spreadsheetId, sheetName }) {
  if (!spreadsheetId) return { ok: false, error: "缺少 spreadsheetId" };
  if (!sheetName) return { ok: false, error: "缺少 sheetName" };
  try {
    const { auth, sa } = await getAuth();
    const { google } = require("googleapis");
    const sheets = google.sheets({ version: "v4", auth });

    // 1. 先读分页 metadata 看分页存不存在 + 用户能不能访问
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "properties.title,sheets.properties(title,sheetId)",
    });
    const tabs = (meta.data.sheets || []).map(s => s.properties.title);
    if (!tabs.includes(sheetName)) {
      return {
        ok: false,
        error: `分页 "${sheetName}" 不存在. 此 Sheet 现有分页: ${tabs.join(", ")}`,
        sheetTitle: meta.data.properties?.title,
        availableTabs: tabs,
      };
    }

    // 2. 追加一条测试行
    const now = new Date();
    const ts = now.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
    const testRow = [`[连线测试] ${ts}`, `by ${sa.client_email}`, "会自动删除"];
    const append = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A:C`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [testRow] },
    });

    // 3. 删掉刚写的那行 (保持 Sheet 干净)
    const updatedRange = append.data.updates?.updatedRange || "";
    const m = updatedRange.match(/!A(\d+):/);
    if (m) {
      const rowIdx = Number(m[1]) - 1; // 0-based
      const sheetId = meta.data.sheets.find(s => s.properties.title === sheetName)?.properties.sheetId;
      if (sheetId !== undefined) {
        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [{
                deleteDimension: {
                  range: { sheetId, dimension: "ROWS", startIndex: rowIdx, endIndex: rowIdx + 1 },
                },
              }],
            },
          });
        } catch (delErr) {
          // 删除失败不算整体失败 (写入成功就算测试通过)
          return {
            ok: true,
            sheetTitle: meta.data.properties?.title,
            writtenRange: updatedRange,
            cleanupWarning: `写入成功但清理测试行失败: ${delErr.message}. 请手动删行 ${rowIdx + 1}`,
          };
        }
      }
    }

    return {
      ok: true,
      sheetTitle: meta.data.properties?.title,
      writtenRange: updatedRange,
    };
  } catch (e) {
    return { ok: false, error: translate(e) };
  }
}

async function listSheetTabs({ spreadsheetId }) {
  if (!spreadsheetId) return { ok: false, error: "请填 Spreadsheet ID" };
  try {
    const { auth } = await getAuth();
    const { google } = require("googleapis");
    const sheets = google.sheets({ version: "v4", auth });
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "properties.title,sheets.properties(title,sheetId,index)",
    });
    const tabs = (meta.data.sheets || [])
      .sort((a, b) => (a.properties.index || 0) - (b.properties.index || 0))
      .map(s => ({ title: s.properties.title, sheetId: s.properties.sheetId }));
    return {
      ok: true,
      spreadsheetTitle: meta.data.properties?.title,
      tabs,
    };
  } catch (e) {
    return { ok: false, error: translate(e) };
  }
}

module.exports = { testGsa, testSheetWrite, listSheetTabs };
