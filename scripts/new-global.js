#!/usr/bin/env node
// scripts/new-global.js — 建立全局进程目录
//
// 全局进程 (baseline 架构):
//   - title-sheet-writer  : 跨部门群名变更汇总 (订阅多个中转群, 分流写 Sheet)
//   - review-report-writer: 审查报告闭环跟踪 (订阅多个审查报告群, 汇总到一本总表)
//
// 用法 (CLI):
//   node scripts/new-global.js <kind>
//   node scripts/new-global.js title-sheet-writer
//   node scripts/new-global.js review-report-writer
//
// 跟 new-dept.js 一样: 从 global/_template/<kind>/ 复制到 global/<kind>/
// 不覆写既有目录. 实际 config 要自行编辑 + 走 login-global 产生 session.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GLOBAL_DIR = path.join(ROOT, "global");
const TEMPLATE_DIR = path.join(GLOBAL_DIR, "_template");
const SYSTEM_JSON = path.join(ROOT, "data", "system.json");

// v0.4: title-sheet-writer 已合并到 worker.js 中 (每个部门 worker 自己写群名变更 Sheet),
// 只保留 review-report-writer (跨部门闭环配对需要全局订阅)
const KINDS = ["review-report-writer"];

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function validateKind(kind) {
  if (!kind) return { ok: false, reason: "必须指定 kind" };
  if (!KINDS.includes(kind)) {
    return { ok: false, reason: `kind 必须是: ${KINDS.join(" | ")}` };
  }
  return { ok: true };
}

async function createGlobal(kind, { tgApiId, tgApiHash } = {}) {
  const v = validateKind(kind);
  if (!v.ok) throw new Error(v.reason);

  const srcDir = path.join(TEMPLATE_DIR, kind);
  const dstDir = path.join(GLOBAL_DIR, kind);

  if (!fs.existsSync(srcDir)) {
    throw new Error(`找不到范本: global/_template/${kind}/`);
  }
  if (fs.existsSync(dstDir)) {
    throw new Error(`已存在: global/${kind}/. 要重建先 rm -rf 它 (或用 Web 删除)`);
  }

  // TG API 凭证
  const sys = readJsonSafe(SYSTEM_JSON) || {};
  const apiId = tgApiId || sys.tgApiId || "";
  const apiHash = tgApiHash || sys.tgApiHash || "";

  // 建目录 + 复制范本
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
    `# ${kind} — 从 system.json 继承的 TG API 凭证`,
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
      `编辑 global/${kind}/config.json (填 spreadsheetId / routes / inputChatNames)`,
      !apiId ? `填入 TG_API_ID 到 global/${kind}/.env` : null,
      !apiHash ? `填入 TG_API_HASH 同上` : null,
      `跑 TG 登入: node scripts/login-global.js ${kind}`,
      `重生 PM2 配置: node scripts/generate-ecosystem.js`,
      `启动: pm2 start ecosystem.config.js --only tg-${kind}`,
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
        console.log("  ⚠ TG API 凭证未设定 (data/system.json 没值)");
      }
      console.log("\n下一步:");
      result.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    })
    .catch(err => {
      console.error(`✗ 失败: ${err.message}`);
      process.exit(1);
    });
}
