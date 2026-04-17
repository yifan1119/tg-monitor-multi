#!/usr/bin/env node
// scripts/new-dept.js
//
// 新增部门 — 核心逻辑。CLI 和 Web 都呼叫这个。
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

// ─── 验证 ────────────────────────────────────────────
function validateDeptName(name) {
  if (!name || typeof name !== "string") {
    return { ok: false, reason: "部门代号不能为空" };
  }
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(name)) {
    return { ok: false, reason: "部门代号必须：小写字母开头、2-32 字符、只含 a-z / 0-9 / -" };
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, reason: `“${name}”是保留字` };
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

// ─── 建部门 ───────────────────────────────────────────
async function createDept({
  name,
  display,
  outputChat,
  spreadsheetId,
  sheetTab,
  tgApiId,       // 可选：不提供就从 data/system.json 读
  tgApiHash,     // 可选：同上
}) {
  // 验证名称
  const v = validateDeptName(name);
  if (!v.ok) throw new Error(v.reason);

  // 必填检查
  const required = { display, outputChat, spreadsheetId, sheetTab };
  for (const [k, val] of Object.entries(required)) {
    if (!val || !String(val).trim()) {
      throw new Error(`字段 ${k} 不能为空`);
    }
  }

  // 路径冲突
  const target = path.join(DEPTS_DIR, name);
  if (fs.existsSync(target)) {
    throw new Error(`部门已存在: depts/${name}`);
  }

  // 模板检查
  if (!fs.existsSync(TEMPLATE_DIR)) {
    throw new Error(`depts/_template/ 不存在，无法建立部门`);
  }

  // TG API 凭证：若未提供则从 system.json 读
  const sys = getSystemConfig();
  const apiId = tgApiId || sys.tgApiId || "";
  const apiHash = tgApiHash || sys.tgApiHash || "";

  // ─── 建目录 ──────────────────────────────────────
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(target, "state"));

  // ─── 生成 config.json ───────────────────────────
  const templateConfig = readJsonSafe(path.join(TEMPLATE_DIR, "config.json.example"), {});

  // 清理 template 中的 _comment / _*_section 说明键
  const cleaned = {};
  for (const [k, v] of Object.entries(templateConfig)) {
    if (!k.startsWith("_")) cleaned[k] = v;
  }

  // 填入实际值
  cleaned.configVersion = cleaned.configVersion || 1;
  cleaned.display = display;
  cleaned.outputChatName = outputChat;
  cleaned.inputChatName = outputChat;
  cleaned.spreadsheetId = spreadsheetId;
  // sheetName (关键字命中 tab): 用户没填就默认 "关键词命中-<dept>"
  cleaned.sheetName = sheetTab || `关键词命中-${name}`;
  // titleSheet (群名变更 tab, 可选): 默认启用, 同 Sheet 不同分页
  if (spreadsheetId) {
    cleaned.titleSheet = {
      spreadsheetId,
      sheetName: `群名变更-${name}`,
    };
  }

  fs.writeFileSync(
    path.join(target, "config.json"),
    JSON.stringify(cleaned, null, 2) + "\n"
  );

  // ─── 生成 .env ───────────────────────────────────
  const envContent = [
    "# Telegram API credentials",
    "# 同一台 VPS 上的多个部门可共用同一组",
    `TG_API_ID=${apiId}`,
    `TG_API_HASH=${apiHash}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(target, ".env"), envContent);

  // ─── 建立空 session.txt 占位（实际内容靠登入填） ──
  // 不建 session.txt — 让 sheet_writer 等脚本明确报“缺 session.txt”而不是跑空内容

  return {
    name,
    deptDir: target,
    apiIdSet: Boolean(apiId),
    apiHashSet: Boolean(apiHash),
    nextSteps: [
      !apiId ? "填入 TG_API_ID 到 depts/" + name + "/.env (或先跑 setup 存系统级)" : null,
      !apiHash ? "填入 TG_API_HASH 同上" : null,
      "跑 TG 登入: node scripts/login-dept.js " + name,
      "重新生成 PM2 配置: node scripts/generate-ecosystem.js",
      "启动进程: pm2 start ecosystem.config.js --only tg-*-" + name,
    ].filter(Boolean),
  };
}

// ─── 删部门（保留以备后用） ───────────────────────────
async function deleteDept(name) {
  const v = validateDeptName(name);
  if (!v.ok) throw new Error(v.reason);
  const target = path.join(DEPTS_DIR, name);
  if (!fs.existsSync(target)) throw new Error(`部门不存在: ${name}`);
  // 不直接 rm -rf — 移到 .trash-<timestamp> 避免误删
  const trashDir = path.join(DEPTS_DIR, `.trash-${Date.now()}-${name}`);
  fs.renameSync(target, trashDir);
  return { movedTo: trashDir };
}

// ─── 列部门 ───────────────────────────────────────────
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
      console.log(`✓ 部门已建立: ${result.deptDir}`);
      if (!result.apiIdSet || !result.apiHashSet) {
        console.log("  ⚠ TG API 凭证未设定（走 Web setup 或手动填 .env）");
      }
      console.log("\n下一步:");
      result.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    })
    .catch(err => {
      console.error(`✗ 失败: ${err.message}`);
      process.exit(1);
    });
}
