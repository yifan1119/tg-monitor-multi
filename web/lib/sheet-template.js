// web/lib/sheet-template.js
//
// 最简版: 新建部门时自动在 Sheet 加分页 + 写表头. 不做其他样式.
// 用户想调样式/斑马纹/冻结 → Google Sheets 里自己操作.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

// 三种预设表头 (跟 baseline 对齐)
const TEMPLATES = {
  keyword: {
    headers: ["编号", "来源群", "发送人", "命中关键词", "消息内容", "登记时间"],
  },
  title: {
    headers: ["序号", "原群名", "新群名", "变更时间", "操作人"],
  },
  review: {
    headers: [
      "编号", "外部广告对接群", "产品所属公司", "广告类型", "广告主",
      "对接商务", "对应外事号", "问题情况说明", "初步认定",
      "登记时间", "审查人", "", "闭环详情",
    ],
  },
};

function findGsa() {
  const candidates = [
    path.join(ROOT, "shared", "google-service-account.json"),
    path.join(ROOT, "secrets", "google-service-account.json"),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error("找不到 google-service-account.json");
}

async function getSheets() {
  const { google } = require("googleapis");
  const auth = new google.auth.GoogleAuth({
    keyFile: findGsa(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// 确保分页存在 + 第 1 行有表头. 就这两件事.
async function ensureTemplate({ spreadsheetId, sheetName, type, onlyIfMissing = false }) {
  if (!spreadsheetId || !sheetName) throw new Error("缺少 spreadsheetId 或 sheetName");
  if (!TEMPLATES[type]) throw new Error(`未知模板类型: ${type}`);
  const headers = TEMPLATES[type].headers;

  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "properties.title,sheets.properties(title,sheetId)",
  });
  const existing = (meta.data.sheets || []).find(s => s.properties.title === sheetName);

  if (existing && onlyIfMissing) {
    // 第一格有值 → 认为表头已有, 跳过
    try {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A1:A1` });
      if (r.data.values && r.data.values[0] && r.data.values[0][0]) {
        return { ok: true, skipped: true, sheetName };
      }
    } catch {}
  }

  if (!existing) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
  }

  // 写表头 (row 1). 加粗可以, 但不做其他样式.
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1:${String.fromCharCode(64 + headers.length)}1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers] },
  });

  return { ok: true, created: !existing, sheetName, headers, spreadsheetTitle: meta.data.properties?.title };
}

module.exports = { ensureTemplate, TEMPLATES };
