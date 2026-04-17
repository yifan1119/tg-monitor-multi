// web/lib/sheet-template.js
//
// 模板 = 可完全自定义的列清单. 每列指定:
//   header (显示名) / field (绑的数据字段) / width (像素) / wrap (是否换行)
//
// 用户可自由增删/重排列. worker 按 columns 顺序写 row, 值从对应 field 取.
// 自定义存 data/sheet-templates.json, 覆盖内建默认.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CUSTOM_FILE = path.join(ROOT, "data", "sheet-templates.json");

// 样式
const COLOR = {
  title:       { red: 0.04, green: 0.12, blue: 0.22 },
  titleText:   { red: 0.0,  green: 0.9,  blue: 1.0 },
  header:      { red: 0.08, green: 0.18, blue: 0.30 },
  headerText:  { red: 1.0,  green: 1.0,  blue: 1.0 },
  zebra1:      { red: 1.0,  green: 1.0,  blue: 1.0 },
  zebra2:      { red: 0.96, green: 0.98, blue: 1.0 },
};

// 内建模板
const TEMPLATES = {
  keyword: {
    titleTemplate: "关键字命中记录 — {dept}",
    titleRow: 1, headerRow: 2, dataStartRow: 3,
    columns: [
      { header: "编号",       field: "serialNo",       width: 70,  wrap: false },
      { header: "来源群",     field: "sourceGroup",    width: 220, wrap: false },
      { header: "发送人",     field: "senderName",     width: 160, wrap: false },
      { header: "命中关键词", field: "keyword",        width: 130, wrap: false },
      { header: "消息内容",   field: "messageContent", width: 480, wrap: true  },
      { header: "登记时间",   field: "createdAt",      width: 170, wrap: false },
    ],
    availableFields: {
      serialNo:       "自动序号",
      sourceGroup:    "来源群名",
      senderName:     "发送人 (TG 用户名)",
      keyword:        "命中关键词",
      messageContent: "消息内容摘要",
      createdAt:      "登记时间 (系统当下)",
      messageDate:    "消息实际时间 (TG)",
      messageId:      "TG 消息 ID",
      sourceGroupId:  "来源群 ID",
    },
  },
  title: {
    titleTemplate: "广告账号改名履历 — {dept}",
    titleRow: 1, headerRow: 2, dataStartRow: 3,
    columns: [
      { header: "序号",     field: "serialNo",   width: 70,  wrap: false },
      { header: "原群名",   field: "oldTitle",   width: 240, wrap: false },
      { header: "新群名",   field: "newTitle",   width: 240, wrap: false },
      { header: "变更时间", field: "createdAt",  width: 170, wrap: false },
      { header: "操作人",   field: "senderName", width: 140, wrap: false },
    ],
    availableFields: {
      serialNo:      "自动序号",
      oldTitle:      "原群名",
      newTitle:      "新群名",
      createdAt:     "变更时间",
      senderName:    "操作人 (发起变更的 TG 用户)",
      sourceGroup:   "群当前名 (= 新群名)",
      sourceGroupId: "群 ID",
    },
  },
  review: {
    titleTemplate: "审查报告汇总表",
    titleRow: 1, headerRow: 2, dataStartRow: 3,
    // review 列跟 baseline 的 insertRowAt3AndWrite 紧耦合 (A:reviewNo B:externalGroup ... M:闭环)
    // 改列 = 改 baseline review_report_writer.js 逻辑, 风险大, 先不开放
    columns: [
      { header: "编号",           field: "reviewNo",         width: 140, wrap: false },
      { header: "外部广告对接群", field: "externalGroup",    width: 220, wrap: false },
      { header: "产品所属公司",   field: "company",          width: 160, wrap: false },
      { header: "广告类型",       field: "adType",           width: 110, wrap: false },
      { header: "广告主",         field: "advertiser",       width: 130, wrap: false },
      { header: "对接商务",       field: "businessOwner",    width: 130, wrap: false },
      { header: "对应外事号",     field: "externalOperator", width: 140, wrap: false },
      { header: "问题情况说明",   field: "issueDesc",        width: 340, wrap: true  },
      { header: "初步认定",       field: "initialFinding",   width: 340, wrap: true  },
      { header: "登记时间",       field: "createdAt",        width: 170, wrap: false },
      { header: "审查人",         field: "reviewer",         width: 110, wrap: false },
      { header: "",               field: "_empty",           width: 60,  wrap: false },
      { header: "闭环详情",       field: "closureDetail",    width: 340, wrap: true  },
    ],
    availableFields: {}, // 不可改 (baseline 耦合)
    readOnly: true,
  },
};

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

function renderTitle(tmpl, ctx) {
  const raw = tmpl.titleTemplate || "";
  return raw.replace(/\{dept\}/g, ctx.dept || "部门");
}

// 合并默认 + 自定义, 返回最终模板
function getEffectiveTemplate(type, ctx = {}) {
  const base = TEMPLATES[type];
  if (!base) throw new Error(`未知模板类型: ${type}`);
  const custom = loadCustom()[type] || {};
  const effective = {
    ...base,
    titleTemplate: custom.titleTemplate || base.titleTemplate,
    columns: Array.isArray(custom.columns) && custom.columns.length > 0 ? custom.columns : base.columns,
  };
  effective.title = renderTitle(effective, ctx);
  return effective;
}

// ═════════════════════════════════════════════════════
// Google Sheets 操作: 确保分页存在 + 应用模板
// ═════════════════════════════════════════════════════

const GSA_CANDIDATES = [
  path.join(ROOT, "shared", "google-service-account.json"),
  path.join(ROOT, "secrets", "google-service-account.json"),
];
function findGsa() {
  for (const p of GSA_CANDIDATES) if (fs.existsSync(p)) return p;
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

async function ensureTemplate({ spreadsheetId, sheetName, type, dept, onlyIfMissing = false }) {
  if (!spreadsheetId || !sheetName) throw new Error("缺少 spreadsheetId 或 sheetName");
  if (!TEMPLATES[type]) throw new Error(`未知模板类型: ${type}`);

  const tmpl = getEffectiveTemplate(type, { dept });
  const colCount = tmpl.columns.length;
  const sheets = await getSheets();

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "properties.title,sheets.properties(title,sheetId)",
  });
  const existing = (meta.data.sheets || []).find(s => s.properties.title === sheetName);
  let sheetId;

  if (existing && onlyIfMissing) {
    try {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A1:A1` });
      if (r.data.values && r.data.values[0] && r.data.values[0][0]) {
        return { ok: true, skipped: true, reason: "template already applied", sheetName };
      }
    } catch {}
  }

  if (existing) {
    sheetId = existing.properties.sheetId;
  } else {
    const r = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName, gridProperties: { rowCount: 1000, columnCount: Math.max(colCount, 10) } } } }],
      },
    });
    sheetId = r.data.replies[0].addSheet.properties.sheetId;
  }

  const requests = [];

  // 清 merges
  requests.push({
    unmergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: tmpl.dataStartRow - 1, startColumnIndex: 0, endColumnIndex: Math.max(colCount, 30) } },
  });

  // 清 banding
  if (existing) {
    try {
      const m2 = await sheets.spreadsheets.get({ spreadsheetId, ranges: [sheetName], fields: "sheets(bandedRanges(bandedRangeId))" });
      const targetSheet = (m2.data.sheets || [])[0];
      for (const b of (targetSheet?.bandedRanges || [])) {
        requests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
      }
    } catch {}
  }

  // merge + 标题
  requests.push({
    mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: colCount }, mergeType: "MERGE_ALL" },
  });
  requests.push({
    updateCells: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
      rows: [{
        values: [{
          userEnteredValue: { stringValue: tmpl.title },
          userEnteredFormat: {
            backgroundColor: COLOR.title, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE",
            textFormat: { foregroundColor: COLOR.titleText, bold: true, fontSize: 14 },
          },
        }],
      }],
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  // 表头
  requests.push({
    updateCells: {
      range: { sheetId, startRowIndex: tmpl.headerRow - 1, endRowIndex: tmpl.headerRow, startColumnIndex: 0, endColumnIndex: colCount },
      rows: [{
        values: tmpl.columns.map(c => ({
          userEnteredValue: { stringValue: c.header },
          userEnteredFormat: {
            backgroundColor: COLOR.header, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE",
            textFormat: { foregroundColor: COLOR.headerText, bold: true },
          },
        })),
      }],
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  // 行高
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 40 }, fields: "pixelSize" } });
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: tmpl.headerRow - 1, endIndex: tmpl.headerRow }, properties: { pixelSize: 32 }, fields: "pixelSize" } });

  // 冻结
  requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: tmpl.headerRow } }, fields: "gridProperties.frozenRowCount" } });

  // 斑马纹
  requests.push({
    addBanding: {
      bandedRange: {
        range: { sheetId, startRowIndex: tmpl.dataStartRow - 1, startColumnIndex: 0, endColumnIndex: colCount },
        rowProperties: { firstBandColor: COLOR.zebra1, secondBandColor: COLOR.zebra2 },
      },
    },
  });

  // 列宽
  tmpl.columns.forEach((c, idx) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: idx, endIndex: idx + 1 },
        properties: { pixelSize: c.width || 120 },
        fields: "pixelSize",
      },
    });
  });

  // wrap
  tmpl.columns.forEach((c, idx) => {
    if (!c.wrap) return;
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: tmpl.dataStartRow - 1, startColumnIndex: idx, endColumnIndex: idx + 1 },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } },
        fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment",
      },
    });
  });

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  return { ok: true, created: !existing, sheetName, columns: tmpl.columns, spreadsheetTitle: meta.data.properties?.title };
}

module.exports = {
  TEMPLATES,
  loadCustom,
  saveCustom,
  getEffectiveTemplate,
  ensureTemplate,
};
