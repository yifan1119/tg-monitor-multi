#!/usr/bin/env node
// scripts/new-dept.js
//
// 新增部門 — 核心邏輯。CLI 和 Web 都呼叫這個。
//
// 用法 (CLI):
//   node scripts/new-dept.js <dept_name> <display_name> "<output_chat>" <spreadsheet_id> "<sheet_tab>"
//
// 用法 (程式引用):
//   const { createDept, validateDeptName } = require("./scripts/new-dept");
//   await createDept({ name, display, outputChat, spreadsheetId, sheetTab });

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEPTS_DIR = path.join(ROOT, "depts");
const TEMPLATE_DIR = path.join(DEPTS_DIR, "_template");
const DATA_DIR = path.join(ROOT, "data");
const SYSTEM_JSON = path.join(DATA_DIR, "system.json");

const RESERVED_NAMES = new Set(["_template", "_shared", "_global", "root", "admin", "api", "new", "edit"]);

// ─── 驗證 ────────────────────────────────────────────
function validateDeptName(name) {
  if (!name || typeof name !== "string") {
    return { ok: false, reason: "部門代號不能為空" };
  }
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(name)) {
    return { ok: false, reason: "部門代號必須：小寫字母開頭、2-32 字符、只含 a-z / 0-9 / -" };
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, reason: `「${name}」是保留字` };
  }
  return { ok: true };
}

function readJsonSafe(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function getSystemConfig() {
  return readJsonSafe(SYSTEM_JSON, {});
}

// ─── 建部門 ───────────────────────────────────────────
async function createDept({
  name,
  display,
  outputChat,
  spreadsheetId,
  sheetTab,
  tgApiId,       // 可選：不提供就從 data/system.json 讀
  tgApiHash,     // 可選：同上
}) {
  // 驗證名稱
  const v = validateDeptName(name);
  if (!v.ok) throw new Error(v.reason);

  // 必填檢查
  const required = { display, outputChat, spreadsheetId, sheetTab };
  for (const [k, val] of Object.entries(required)) {
    if (!val || !String(val).trim()) {
      throw new Error(`欄位 ${k} 不能為空`);
    }
  }

  // 路徑衝突
  const target = path.join(DEPTS_DIR, name);
  if (fs.existsSync(target)) {
    throw new Error(`部門已存在: depts/${name}`);
  }

  // 模板檢查
  if (!fs.existsSync(TEMPLATE_DIR)) {
    throw new Error(`depts/_template/ 不存在，無法建立部門`);
  }

  // TG API 憑證：若未提供則從 system.json 讀
  const sys = getSystemConfig();
  const apiId = tgApiId || sys.tgApiId || "";
  const apiHash = tgApiHash || sys.tgApiHash || "";

  // ─── 建目錄 ──────────────────────────────────────
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(target, "state"));

  // ─── 生成 config.json ───────────────────────────
  const templateConfig = readJsonSafe(path.join(TEMPLATE_DIR, "config.json.example"), {});

  // 清理 template 中的 _comment / _*_section 說明鍵
  const cleaned = {};
  for (const [k, v] of Object.entries(templateConfig)) {
    if (!k.startsWith("_")) cleaned[k] = v;
  }

  // 填入實際值
  cleaned.configVersion = cleaned.configVersion || 1; // schema 版號 (為 migrate 腳本預留)
  cleaned.display = display;
  cleaned.outputChatName = outputChat;
  cleaned.inputChatName = outputChat; // listener 推到這、sheet_writer 訂閱這
  cleaned.spreadsheetId = spreadsheetId;
  cleaned.sheetName = sheetTab;

  fs.writeFileSync(
    path.join(target, "config.json"),
    JSON.stringify(cleaned, null, 2) + "\n"
  );

  // ─── 生成 .env ───────────────────────────────────
  const envContent = [
    "# Telegram API credentials",
    "# 同一台 VPS 上的多個部門可共用同一組",
    `TG_API_ID=${apiId}`,
    `TG_API_HASH=${apiHash}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(target, ".env"), envContent);

  // ─── 建立空 session.txt 佔位（實際內容靠登入填） ──
  // 不建 session.txt — 讓 sheet_writer 等腳本明確報「缺 session.txt」而不是跑空內容

  return {
    name,
    deptDir: target,
    apiIdSet: Boolean(apiId),
    apiHashSet: Boolean(apiHash),
    nextSteps: [
      !apiId ? "填入 TG_API_ID 到 depts/" + name + "/.env (或先跑 setup 存系統級)" : null,
      !apiHash ? "填入 TG_API_HASH 同上" : null,
      "跑 TG 登入: node scripts/login-dept.js " + name,
      "重新生成 PM2 配置: node scripts/generate-ecosystem.js",
      "啟動進程: pm2 start ecosystem.config.js --only tg-*-" + name,
    ].filter(Boolean),
  };
}

// ─── 刪部門（保留以備後用） ───────────────────────────
async function deleteDept(name) {
  const v = validateDeptName(name);
  if (!v.ok) throw new Error(v.reason);
  const target = path.join(DEPTS_DIR, name);
  if (!fs.existsSync(target)) throw new Error(`部門不存在: ${name}`);
  // 不直接 rm -rf — 移到 .trash-<timestamp> 避免誤刪
  const trashDir = path.join(DEPTS_DIR, `.trash-${Date.now()}-${name}`);
  fs.renameSync(target, trashDir);
  return { movedTo: trashDir };
}

// ─── 列部門 ───────────────────────────────────────────
function listDepts() {
  if (!fs.existsSync(DEPTS_DIR)) return [];
  return fs.readdirSync(DEPTS_DIR).filter(n => {
    if (n.startsWith("_") || n.startsWith(".")) return false;
    return fs.statSync(path.join(DEPTS_DIR, n)).isDirectory();
  });
}

module.exports = {
  validateDeptName,
  createDept,
  deleteDept,
  listDepts,
  getSystemConfig,
  ROOT,
  DEPTS_DIR,
};

// ═══════════════════════════════════════════════════
// CLI 入口
// ═══════════════════════════════════════════════════
if (require.main === module) {
  const [name, display, outputChat, spreadsheetId, sheetTab] = process.argv.slice(2);

  if (!name || !display || !outputChat || !spreadsheetId || !sheetTab) {
    console.error("用法: node scripts/new-dept.js <dept_name> <display> <output_chat> <spreadsheet_id> <sheet_tab>");
    console.error("例: node scripts/new-dept.js yueda 悦达 悦达-业务审查 1Q9pMXg5... 关键词提醒yd");
    process.exit(1);
  }

  createDept({ name, display, outputChat, spreadsheetId, sheetTab })
    .then(result => {
      console.log(`✓ 部門已建立: ${result.deptDir}`);
      if (!result.apiIdSet || !result.apiHashSet) {
        console.log("  ⚠ TG API 憑證未設定（走 Web setup 或手動填 .env）");
      }
      console.log("\n下一步:");
      result.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    })
    .catch(err => {
      console.error(`✗ 失敗: ${err.message}`);
      process.exit(1);
    });
}
