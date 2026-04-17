// web/lib/sheet-template.js
//
// Sheet 模板: 自动建分页 + 标题行 + 粗体表头 + 冻结 + 斑马纹 + 列宽 + 文本换行
//
// 结构:
//   Row 1: 标题 (合并单元格, 深蓝底 + 青色粗体字, 居中)
//   Row 2: 表头 (中蓝底 + 白色粗体字)
//   Row 3+: 数据 (白 / 淡蓝斑马纹)
//   冻结到 Row 2, 列宽按每列配置

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

// 色系 (霓虹科技风, 跟 Web UI 对齐)
const COLOR = {
  title:       { red: 0.04, green: 0.12, blue: 0.22 },  // 深蓝底
  titleText:   { red: 0.0,  green: 0.9,  blue: 1.0 },   // 青色字
  header:      { red: 0.08, green: 0.18, blue: 0.30 },  // 中蓝底
  headerText:  { red: 1.0,  green: 1.0,  blue: 1.0 },   // 白字
  zebra1:      { red: 1.0,  green: 1.0,  blue: 1.0 },   // 白
  zebra2:      { red: 0.96, green: 0.98, blue: 1.0 },   // 淡蓝
};

// 三种预设模板
const TEMPLATES = {
  keyword: {
    titleTemplate: "关键字命中记录 — {dept}",
    columns: [
      { header: "编号",       width: 70,  wrap: false },
      { header: "来源群",     width: 220, wrap: false },
      { header: "发送人",     width: 160, wrap: false },
      { header: "命中关键词", width: 130, wrap: false },
      { header: "消息内容",   width: 480, wrap: true  },
      { header: "登记时间",   width: 170, wrap: false },
    ],
  },
  title: {
    titleTemplate: "广告账号改名履历 — {dept}",
    columns: [
      { header: "序号",     width: 70,  wrap: false },
      { header: "原群名",   width: 240, wrap: false },
      { header: "新群名",   width: 240, wrap: false },
      { header: "变更时间", width: 170, wrap: false },
      { header: "操作人",   width: 140, wrap: false },
    ],
  },
  review: {
    titleTemplate: "审查报告汇总表",
    columns: [
      { header: "编号",           width: 130, wrap: false },
      { header: "外部广告对接群", width: 150, wrap: false },
      { header: "产品所属公司",   width: 120, wrap: false },
      { header: "广告类型",       width: 85,  wrap: false },
      { header: "广告主",         width: 95,  wrap: false },
      { header: "对接商务",       width: 95,  wrap: false },
      { header: "对应外事号",     width: 105, wrap: false },
      { header: "问题情况说明",   width: 260, wrap: true  },
      { header: "初步认定",       width: 260, wrap: true  },
      { header: "登记时间",       width: 150, wrap: false },
      { header: "审查人",         width: 85,  wrap: false },
      { header: "",               width: 40,  wrap: false }, // 占位空列
      { header: "闭环详情",       width: 260, wrap: true  },
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

async function ensureTemplate({ spreadsheetId, sheetName, type, dept, onlyIfMissing = false }) {
  if (!spreadsheetId || !sheetName) throw new Error("缺少 spreadsheetId 或 sheetName");
  if (!TEMPLATES[type]) throw new Error(`未知模板类型: ${type}`);

  const tmpl = TEMPLATES[type];
  const title = (tmpl.titleTemplate || "").replace(/\{dept\}/g, dept || "部门");
  const headers = tmpl.columns.map(c => c.header);
  const colCount = tmpl.columns.length;

  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "properties.title,sheets.properties(title,sheetId)",
  });
  const existing = (meta.data.sheets || []).find(s => s.properties.title === sheetName);
  let sheetId;

  // onlyIfMissing: 标题行已有内容就跳过 (避免覆盖用户已调好的样式)
  if (existing && onlyIfMissing) {
    try {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A1:A1` });
      if (r.data.values && r.data.values[0] && r.data.values[0][0]) {
        return { ok: true, skipped: true, sheetName };
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

  // 清 merges (避免重叠错)
  requests.push({
    unmergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: Math.max(colCount, 30) } },
  });

  // 清旧 banding
  if (existing) {
    try {
      const m2 = await sheets.spreadsheets.get({ spreadsheetId, ranges: [sheetName], fields: "sheets(bandedRanges(bandedRangeId))" });
      const targetSheet = (m2.data.sheets || [])[0];
      for (const b of (targetSheet?.bandedRanges || [])) {
        requests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
      }
    } catch {}
  }

  // Row 1: merge + 标题
  requests.push({
    mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: colCount }, mergeType: "MERGE_ALL" },
  });
  requests.push({
    updateCells: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
      rows: [{
        values: [{
          userEnteredValue: { stringValue: title },
          userEnteredFormat: {
            backgroundColor: COLOR.title, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE",
            textFormat: { foregroundColor: COLOR.titleText, bold: true, fontSize: 14 },
          },
        }],
      }],
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  // Row 2: 表头
  requests.push({
    updateCells: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: colCount },
      rows: [{
        values: headers.map(h => ({
          userEnteredValue: { stringValue: h },
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
  requests.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 32 }, fields: "pixelSize" } });

  // 冻结前 2 行
  requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 2 } }, fields: "gridProperties.frozenRowCount" } });

  // 斑马纹: row 3 起
  requests.push({
    addBanding: {
      bandedRange: {
        range: { sheetId, startRowIndex: 2, startColumnIndex: 0, endColumnIndex: colCount },
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

  // Wrap (长文本列)
  tmpl.columns.forEach((c, idx) => {
    if (!c.wrap) return;
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 2, startColumnIndex: idx, endColumnIndex: idx + 1 },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP", verticalAlignment: "TOP" } },
        fields: "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment",
      },
    });
  });

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  return { ok: true, created: !existing, sheetName, headers, spreadsheetTitle: meta.data.properties?.title };
}

module.exports = { ensureTemplate, TEMPLATES };
