// web/lib/sheet-template.js
//
// 自动初始化 Sheet 模板: 没分页 → 加分页, 有分页 → 清空重建.
// 三种模板:
//   keyword  — 关键字命中表 (dept worker 写)
//   title    — 群名变更表 (dept worker 写, 可选)
//   review   — 审查报告汇总表 (全局 review-report-writer 写)
//
// 统一风格: 标题行 + 表头行 (冻结) + 斑马纹

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CUSTOM_FILE = path.join(ROOT, "data", "sheet-templates.json");

// 读用户自定义 (若有) 覆盖默认模板
function loadCustom() {
  try {
    if (fs.existsSync(CUSTOM_FILE)) return JSON.parse(fs.readFileSync(CUSTOM_FILE, "utf8"));
  } catch {}
  return {};
}

function saveCustom(type, patch) {
  const all = loadCustom();
  all[type] = { ...(all[type] || {}), ...patch };
  if (!fs.existsSync(path.dirname(CUSTOM_FILE))) fs.mkdirSync(path.dirname(CUSTOM_FILE), { recursive: true });
  fs.writeFileSync(CUSTOM_FILE, JSON.stringify(all, null, 2));
  return all[type];
}

// 合并默认 + 用户自定义, 返回最终模板
function getEffectiveTemplate(type, ctx = {}) {
  const base = TEMPLATES[type];
  if (!base) throw new Error(`未知模板类型: ${type}`);
  const custom = loadCustom()[type] || {};
  // title 支持字串或 function
  const titleFn = typeof custom.title === "string"
    ? () => custom.title.replace(/\{dept\}/g, ctx.dept || "部门")
    : base.title;
  return {
    ...base,
    title: titleFn,
    headers: custom.headers || base.headers,
    columnWidths: custom.columnWidths || base.columnWidths,
  };
}
const GSA_PATH_CANDIDATES = [
  path.join(ROOT, "shared", "google-service-account.json"),
  path.join(ROOT, "secrets", "google-service-account.json"),
];

function findGsa() {
  for (const p of GSA_PATH_CANDIDATES) if (fs.existsSync(p)) return p;
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

// 颜色: 霓虹科技风对齐 Web UI
const COLOR = {
  title:       { red: 0.04, green: 0.12, blue: 0.22 },        // 深蓝底
  titleText:   { red: 0.0,  green: 0.9,  blue: 1.0 },         // 青色字
  header:      { red: 0.08, green: 0.18, blue: 0.30 },        // 中蓝底
  headerText:  { red: 1.0,  green: 1.0,  blue: 1.0 },         // 白字
  zebra1:      { red: 1.0,  green: 1.0,  blue: 1.0 },         // 白
  zebra2:      { red: 0.96, green: 0.98, blue: 1.0 },         // 淡蓝白
};

const TEMPLATES = {
  keyword: {
    title: (ctx) => `关键字命中记录 — ${ctx.dept || "部门"}`,
    headers: ["编号", "来源群", "发送人", "命中关键词", "消息内容", "登记时间"],
    columnWidths: [70, 220, 160, 130, 480, 170],
    wrapColumns: [4],
    titleRow: 1,
    blankRows: [],
    headerRow: 2,
    dataStartRow: 3,
  },
  title: {
    title: (ctx) => `广告账号改名履历 — ${ctx.dept || "部门"}`,
    headers: ["序号", "原群名", "新群名", "变更时间", "操作人"],
    columnWidths: [70, 240, 240, 170, 140],
    wrapColumns: [],
    titleRow: 1,
    blankRows: [],
    headerRow: 2,
    dataStartRow: 3,
  },
  review: {
    title: () => "审查报告汇总表",
    headers: [
      "编号", "外部广告对接群", "产品所属公司", "广告类型", "广告主",
      "对接商务", "对应外事号", "问题情况说明", "初步认定",
      "登记时间", "审查人", "", "闭环详情",
    ],
    columnWidths: [140, 220, 160, 110, 130, 130, 140, 340, 340, 170, 110, 60, 340],
    wrapColumns: [7, 8, 12], // 问题情况说明 / 初步认定 / 闭环详情
    titleRow: 1,
    blankRows: [],
    headerRow: 2,
    dataStartRow: 3,
  },
};

// 主函数: 确保分页存在 + 应用模板
// opts.onlyIfMissing = true → 已有标题 (说明模板已应用) 就跳过, 不覆盖
async function ensureTemplate({ spreadsheetId, sheetName, type, dept, onlyIfMissing = false }) {
  if (!spreadsheetId || !sheetName) throw new Error("缺少 spreadsheetId 或 sheetName");
  if (!TEMPLATES[type]) throw new Error(`未知模板类型: ${type}`);
  const tmpl = getEffectiveTemplate(type, { dept });

  const sheets = await getSheets();

  // 1. 看分页是否存在
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "properties.title,sheets.properties(title,sheetId)",
  });
  const existing = (meta.data.sheets || []).find(s => s.properties.title === sheetName);
  let sheetId;

  // onlyIfMissing: 分页已存在 + 第 1 行有内容 → 认为模板已应用, 跳过
  if (existing && onlyIfMissing) {
    try {
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A1:A1`,
      });
      if (r.data.values && r.data.values[0] && r.data.values[0][0]) {
        return { ok: true, skipped: true, reason: "template already applied", sheetName };
      }
    } catch {}
  }

  if (existing) {
    sheetId = existing.properties.sheetId;
  } else {
    // 加新分页
    const r = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName, gridProperties: { rowCount: 1000, columnCount: Math.max(tmpl.headers.length, 10) } } } }],
      },
    });
    sheetId = r.data.replies[0].addSheet.properties.sheetId;
  }

  const colCount = tmpl.headers.length;
  const context = { dept };

  // 2. 写标题行 (merge A1:颜色 B1 ... 到最后列)
  const requests = [];

  // 清空已有的 merges (避免重叠错)
  requests.push({
    unmergeCells: {
      range: { sheetId, startRowIndex: 0, endRowIndex: tmpl.dataStartRow - 1, startColumnIndex: 0, endColumnIndex: colCount },
    },
  });

  // 清空已有 banding
  if (existing) {
    // 先查已有 banding 删掉
    try {
      const m2 = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [sheetName],
        fields: "sheets(bandedRanges(bandedRangeId))",
      });
      const targetSheet = (m2.data.sheets || [])[0];
      const existingBandings = targetSheet?.bandedRanges || [];
      for (const b of existingBandings) {
        requests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
      }
    } catch {}
  }

  // Merge 标题行
  requests.push({
    mergeCells: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: colCount },
      mergeType: "MERGE_ALL",
    },
  });

  // 标题行样式 + 文本
  requests.push({
    updateCells: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
      rows: [{
        values: [{
          userEnteredValue: { stringValue: tmpl.title(context) },
          userEnteredFormat: {
            backgroundColor: COLOR.title,
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            textFormat: { foregroundColor: COLOR.titleText, bold: true, fontSize: 14 },
          },
        }],
      }],
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  // 表头行样式 + 文本
  requests.push({
    updateCells: {
      range: { sheetId, startRowIndex: tmpl.headerRow - 1, endRowIndex: tmpl.headerRow, startColumnIndex: 0, endColumnIndex: colCount },
      rows: [{
        values: tmpl.headers.map(h => ({
          userEnteredValue: { stringValue: h },
          userEnteredFormat: {
            backgroundColor: COLOR.header,
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            textFormat: { foregroundColor: COLOR.headerText, bold: true },
          },
        })),
      }],
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  // 行高 (标题行高点)
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 40 },
      fields: "pixelSize",
    },
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: "ROWS", startIndex: tmpl.headerRow - 1, endIndex: tmpl.headerRow },
      properties: { pixelSize: 32 },
      fields: "pixelSize",
    },
  });

  // 冻结标题行 + 表头行
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: tmpl.headerRow } },
      fields: "gridProperties.frozenRowCount",
    },
  });

  // 斑马纹 (banding): 从 dataStartRow 开始到最后
  requests.push({
    addBanding: {
      bandedRange: {
        range: {
          sheetId,
          startRowIndex: tmpl.dataStartRow - 1,
          startColumnIndex: 0,
          endColumnIndex: colCount,
        },
        rowProperties: {
          firstBandColor: COLOR.zebra1,
          secondBandColor: COLOR.zebra2,
        },
      },
    },
  });

  // 显式列宽 (每列单独设, 比 autoResize 更可控)
  (tmpl.columnWidths || []).forEach((w, idx) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: idx, endIndex: idx + 1 },
        properties: { pixelSize: w },
        fields: "pixelSize",
      },
    });
  });

  // 内容列开 word wrap (长文本自动换行, 不会挤一起也不会被截断)
  (tmpl.wrapColumns || []).forEach((col) => {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: tmpl.dataStartRow - 1, startColumnIndex: col, endColumnIndex: col + 1 },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } },
        fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment",
      },
    });
  });

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  return {
    ok: true,
    created: !existing,
    sheetName,
    headers: tmpl.headers,
    spreadsheetTitle: meta.data.properties?.title,
  };
}

module.exports = { ensureTemplate, TEMPLATES, loadCustom, saveCustom, getEffectiveTemplate };
