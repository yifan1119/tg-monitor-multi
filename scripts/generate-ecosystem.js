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
const { listGlobals } = require("./new-global");

const ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(ROOT, "ecosystem.config.js");
const SHARED_DIR = path.join(ROOT, "shared");
const DEPTS_DIR = path.join(ROOT, "depts");
const GLOBAL_DIR = path.join(ROOT, "global");

const DEPT_KINDS = [
  { kind: "listener",      script: "listener.js" },
  { kind: "system-events", script: "system_events.js" },
  { kind: "sheet-writer",  script: "sheet_writer.js" },
];

const GLOBAL_KINDS = [
  { kind: "title-sheet-writer",   script: "title_sheet_writer.js" },
  { kind: "review-report-writer", script: "review_report_writer.js" },
];

function buildDeptApp(deptName, kind) {
  const spec = DEPT_KINDS.find(p => p.kind === kind);
  const cwd = path.join(DEPTS_DIR, deptName);
  return {
    name: `tg-${kind}-${deptName}`,
    script: path.join(SHARED_DIR, spec.script),
    cwd,
    autorestart: true,
    max_restarts: 10,
    min_uptime: "10s",
    restart_delay: 3000,
    error_file: path.join(cwd, "state", `${kind}.error.log`),
    out_file:   path.join(cwd, "state", `${kind}.out.log`),
    merge_logs: true,
    env: { NODE_ENV: "production" },
  };
}

function buildGlobalApp(kind) {
  const spec = GLOBAL_KINDS.find(p => p.kind === kind);
  const cwd = path.join(GLOBAL_DIR, kind);
  return {
    name: `tg-${kind}`,  // 全局進程: 不帶 dept 尾綴
    script: path.join(SHARED_DIR, spec.script),
    cwd,
    autorestart: true,
    max_restarts: 10,
    min_uptime: "10s",
    restart_delay: 3000,
    error_file: path.join(cwd, "state", `${kind}.error.log`),
    out_file:   path.join(cwd, "state", `${kind}.out.log`),
    merge_logs: true,
    env: { NODE_ENV: "production" },
  };
}

function generate() {
  const depts = listDepts();
  const globals = listGlobals();
  const apps = [];

  for (const dept of depts) {
    for (const { kind } of DEPT_KINDS) {
      apps.push(buildDeptApp(dept, kind));
    }
  }
  for (const kind of globals) {
    apps.push(buildGlobalApp(kind));
  }

  return {
    apps,
    deptCount: depts.length,
    globalCount: globals.length,
    procCount: apps.length,
  };
}

function serialize(config) {
  const header = [
    "// ecosystem.config.js",
    "// 自動生成 — 勿手動編輯。重跑: node scripts/generate-ecosystem.js",
    `// 生成時間: ${new Date().toISOString()}`,
    `// 部門: ${config.deptCount} 個 × 3 類 + 全局: ${config.globalCount} 個 = ${config.apps.length} 個進程`,
    "",
    "module.exports = ",
  ].join("\n");
  return header + JSON.stringify({ apps: config.apps }, null, 2) + ";\n";
}

function summary(config) {
  const deptProcs = config.deptCount * 3;
  const parts = [
    `${config.deptCount} 部門 × 3 類 = ${deptProcs}`,
  ];
  if (config.globalCount > 0) parts.push(`${config.globalCount} 全局`);
  return `${parts.join(" + ")} = ${config.apps.length} 個進程`;
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = generate();
  const content = serialize(result);

  if (dryRun) {
    console.log("═══ DRY RUN ═══");
    console.log(content);
    console.log(`\n[✓] ${summary(result)}`);
    return;
  }

  fs.writeFileSync(OUT_PATH, content);
  console.log(`[✓] 已生成: ${OUT_PATH}`);
  console.log(`    ${summary(result)}`);
  if (result.deptCount === 0 && result.globalCount === 0) {
    console.log(`    (當前沒有部門也沒有全局進程, ecosystem 空的)`);
  }
}

if (require.main === module) main();

module.exports = { generate, serialize };
