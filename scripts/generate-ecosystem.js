#!/usr/bin/env node
// scripts/generate-ecosystem.js
//
// 掃 depts/ 所有部門，生成 ecosystem.config.js (PM2 設定)
//
// 每部門生成 3 條進程:
//   tg-listener-<name>
//   tg-system-events-<name>
//   tg-sheet-writer-<name>
//
// 全域進程 (title-sheet-writer / review-report-writer) MVP 不自動生成
// — 它們需要獨立的 session.txt 和 config, 由管理員另行手動加
//
// 用法:
//   node scripts/generate-ecosystem.js
//   node scripts/generate-ecosystem.js --dry-run   (只印不寫)

"use strict";

const fs = require("fs");
const path = require("path");
const { listDepts } = require("./new-dept");

const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "ecosystem.config.js");
const SHARED_DIR = path.join(ROOT, "shared");
const DEPTS_DIR = path.join(ROOT, "depts");

const PROCESS_KINDS = [
  { kind: "listener",      script: "listener.js" },
  { kind: "system-events", script: "system_events.js" },
  { kind: "sheet-writer",  script: "sheet_writer.js" },
];

function buildApp(deptName, kind) {
  const spec = PROCESS_KINDS.find(p => p.kind === kind);
  return {
    name: `tg-${kind}-${deptName}`,
    script: path.join(SHARED_DIR, spec.script),
    cwd: path.join(DEPTS_DIR, deptName),
    autorestart: true,
    max_restarts: 10,
    min_uptime: "10s",
    restart_delay: 3000,
    error_file: path.join(DEPTS_DIR, deptName, "state", `${kind}.error.log`),
    out_file: path.join(DEPTS_DIR, deptName, "state", `${kind}.out.log`),
    merge_logs: true,
    env: {
      NODE_ENV: "production",
    },
  };
}

function generate() {
  const depts = listDepts();
  const apps = [];

  for (const dept of depts) {
    for (const { kind } of PROCESS_KINDS) {
      apps.push(buildApp(dept, kind));
    }
  }

  return { apps, deptCount: depts.length, procCount: apps.length };
}

function serialize(config) {
  // 用字串模板避免 JSON.stringify 把 script path 變難讀
  const header = [
    "// ecosystem.config.js",
    "// 自動生成 — 勿手動編輯。重跑: node scripts/generate-ecosystem.js",
    `// 生成時間: ${new Date().toISOString()}`,
    `// 部門數: ${config.deptCount}  進程數: ${config.apps.length}`,
    "",
    "module.exports = ",
  ].join("\n");
  return header + JSON.stringify({ apps: config.apps }, null, 2) + ";\n";
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = generate();
  const content = serialize(result);

  if (dryRun) {
    console.log("═══ DRY RUN ═══");
    console.log(content);
    console.log(`\n[✓] ${result.deptCount} 部門 × 3 類 = ${result.apps.length} 個進程`);
    return;
  }

  fs.writeFileSync(OUT_PATH, content);
  console.log(`[✓] 已生成: ${OUT_PATH}`);
  console.log(`    ${result.deptCount} 部門 × 3 類 = ${result.apps.length} 個進程`);
  if (result.deptCount === 0) {
    console.log(`    (當前沒有部門，ecosystem.config.js 是空的)`);
  }
}

if (require.main === module) main();

module.exports = { generate, serialize };
