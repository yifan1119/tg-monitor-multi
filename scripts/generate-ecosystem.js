#!/usr/bin/env node
// scripts/generate-ecosystem.js
//
// 扫 depts/ 所有部门，生成 ecosystem.config.js (PM2 设定)
//
// 每部门生成 3 条进程:
//   tg-listener-<name>
//   tg-system-events-<name>
//   tg-sheet-writer-<name>
//
// 全域进程 (title-sheet-writer / review-report-writer) MVP 不自动生成
// — 它们需要独立的 session.txt 和 config, 由管理员另行手动加
//
// 用法:
//   node scripts/generate-ecosystem.js
//   node scripts/generate-ecosystem.js --dry-run   (只印不写)

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

// v0.4: 每部门只剩 1 个 worker (listener + system-events + sheet-writer 三合一).
// 旧的 DEPT_KINDS (3 进程) 删除, 仅保留 worker.
const DEPT_KINDS = [
  { kind: "worker", script: "worker.js" },
];

// v0.5.1: 全局进程全砍. 关键字 + 群名变更 都在 worker 里.
const GLOBAL_KINDS = [];

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
    name: `tg-${kind}`,  // 全局进程: 不带 dept 尾缀
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
    "// 自动生成 — 勿手动编辑。重跑: node scripts/generate-ecosystem.js",
    `// 生成时间: ${new Date().toISOString()}`,
    `// 部门: ${config.deptCount} 个 × 1 worker + 全局: ${config.globalCount} 个 = ${config.apps.length} 个进程`,
    "",
    "module.exports = ",
  ].join("\n");
  return header + JSON.stringify({ apps: config.apps }, null, 2) + ";\n";
}

function summary(config) {
  const parts = [
    `${config.deptCount} 部门 × 1 worker = ${config.deptCount}`,
  ];
  if (config.globalCount > 0) parts.push(`${config.globalCount} 全局`);
  return `${parts.join(" + ")} = ${config.apps.length} 个进程`;
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
    console.log(`    (当前没有部门也没有全局进程, ecosystem 空的)`);
  }
}

if (require.main === module) main();

module.exports = { generate, serialize };
