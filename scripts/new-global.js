#!/usr/bin/env node
// scripts/new-global.js — 建立全局進程目錄
//
// 全局進程 (baseline 架構):
//   - title-sheet-writer  : 跨部門群名變更彙總 (訂閱多個中轉群, 分流寫 Sheet)
//   - review-report-writer: 審查報告閉環跟蹤 (訂閱多個審查報告群, 彙總到一本總表)
//
// 用法 (CLI):
//   node scripts/new-global.js <kind>
//   node scripts/new-global.js title-sheet-writer
//   node scripts/new-global.js review-report-writer
//
// 跟 new-dept.js 一樣: 從 global/_template/<kind>/ 複製到 global/<kind>/
// 不覆寫既有目錄. 實際 config 要自行編輯 + 走 login-global 產生 session.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GLOBAL_DIR = path.join(ROOT, "global");
const TEMPLATE_DIR = path.join(GLOBAL_DIR, "_template");
const SYSTEM_JSON = path.join(ROOT, "data", "system.json");

const KINDS = ["title-sheet-writer", "review-report-writer"];

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function validateKind(kind) {
  if (!kind) return { ok: false, reason: "必須指定 kind" };
  if (!KINDS.includes(kind)) {
    return { ok: false, reason: `kind 必須是: ${KINDS.join(" | ")}` };
  }
  return { ok: true };
}

async function createGlobal(kind, { tgApiId, tgApiHash } = {}) {
  const v = validateKind(kind);
  if (!v.ok) throw new Error(v.reason);

  const srcDir = path.join(TEMPLATE_DIR, kind);
  const dstDir = path.join(GLOBAL_DIR, kind);

  if (!fs.existsSync(srcDir)) {
    throw new Error(`找不到範本: global/_template/${kind}/`);
  }
  if (fs.existsSync(dstDir)) {
    throw new Error(`已存在: global/${kind}/. 要重建先 rm -rf 它 (或用 Web 刪除)`);
  }

  // TG API 憑證
  const sys = readJsonSafe(SYSTEM_JSON) || {};
  const apiId = tgApiId || sys.tgApiId || "";
  const apiHash = tgApiHash || sys.tgApiHash || "";

  // 建目錄 + 複製範本
  fs.mkdirSync(dstDir);
  fs.mkdirSync(path.join(dstDir, "state"));

  // config.json
  const templateConfig = readJsonSafe(path.join(srcDir, "config.json.example")) || {};
  const cleaned = {};
  for (const [k, v] of Object.entries(templateConfig)) {
    if (!k.startsWith("_")) cleaned[k] = v;
  }
  cleaned.configVersion = cleaned.configVersion || 1;
  fs.writeFileSync(path.join(dstDir, "config.json"), JSON.stringify(cleaned, null, 2) + "\n");

  // .env
  const envContent = [
    `# ${kind} — 從 system.json 繼承的 TG API 憑證`,
    `TG_API_ID=${apiId}`,
    `TG_API_HASH=${apiHash}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dstDir, ".env"), envContent);

  return {
    kind,
    dir: dstDir,
    apiIdSet: Boolean(apiId),
    apiHashSet: Boolean(apiHash),
    nextSteps: [
      `編輯 global/${kind}/config.json (填 spreadsheetId / routes / inputChatNames)`,
      !apiId ? `填入 TG_API_ID 到 global/${kind}/.env` : null,
      !apiHash ? `填入 TG_API_HASH 同上` : null,
      `跑 TG 登入: node scripts/login-global.js ${kind}`,
      `重生 PM2 配置: node scripts/generate-ecosystem.js`,
      `啟動: pm2 start ecosystem.config.js --only tg-${kind}`,
    ].filter(Boolean),
  };
}

async function deleteGlobal(kind) {
  const v = validateKind(kind);
  if (!v.ok) throw new Error(v.reason);
  const dir = path.join(GLOBAL_DIR, kind);
  if (!fs.existsSync(dir)) throw new Error(`不存在: global/${kind}`);
  const trashDir = path.join(GLOBAL_DIR, `.trash-${Date.now()}-${kind}`);
  fs.renameSync(dir, trashDir);
  return { movedTo: trashDir };
}

function listGlobals() {
  if (!fs.existsSync(GLOBAL_DIR)) return [];
  return fs.readdirSync(GLOBAL_DIR).filter(n => {
    if (n.startsWith("_") || n.startsWith(".")) return false;
    return fs.statSync(path.join(GLOBAL_DIR, n)).isDirectory() && KINDS.includes(n);
  });
}

module.exports = {
  KINDS,
  validateKind,
  createGlobal,
  deleteGlobal,
  listGlobals,
  GLOBAL_DIR,
};

// CLI 入口
if (require.main === module) {
  const kind = process.argv[2];
  if (!kind) {
    console.error("用法: node scripts/new-global.js <kind>");
    console.error(`kind: ${KINDS.join(" | ")}`);
    process.exit(1);
  }

  createGlobal(kind)
    .then(result => {
      console.log(`✓ 建立: ${result.dir}`);
      if (!result.apiIdSet || !result.apiHashSet) {
        console.log("  ⚠ TG API 憑證未設定 (data/system.json 沒值)");
      }
      console.log("\n下一步:");
      result.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    })
    .catch(err => {
      console.error(`✗ 失敗: ${err.message}`);
      process.exit(1);
    });
}
