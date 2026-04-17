// web/lib/log-reader.js
//
// 读 state/*.log 日志文件尾. 比 pm2 logs 快 (不依赖 daemon), 跟 generate-ecosystem
// 的 error_file/out_file 路径约定对齐.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

function stateDirFor({ scope, dept, kind }) {
  if (scope === "dept") return path.join(ROOT, "depts", dept, "state");
  if (scope === "global") return path.join(ROOT, "global", kind, "state");
  throw new Error(`unknown scope: ${scope}`);
}

// 文件名约定跟 generate-ecosystem.js 一致: <kind>.out.log / <kind>.error.log
function logFilePath({ scope, dept, kind, type }) {
  const suffix = type === "err" ? "error" : "out";
  return path.join(stateDirFor({ scope, dept, kind }), `${kind}.${suffix}.log`);
}

function readTail({ scope, dept, kind, type = "out", lines = 100 }) {
  const file = logFilePath({ scope, dept, kind, type });
  const result = { file: path.relative(ROOT, file), exists: false, lines: [], totalBytes: 0, truncated: false };
  if (!fs.existsSync(file)) return result;
  const stat = fs.statSync(file);
  result.exists = true;
  result.totalBytes = stat.size;
  result.mtime = stat.mtime.toISOString();
  // 只读最后 256KB (避免读 50MB 日志吃内存)
  const MAX_READ = 256 * 1024;
  let content;
  if (stat.size > MAX_READ) {
    result.truncated = true;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(MAX_READ);
    fs.readSync(fd, buf, 0, MAX_READ, stat.size - MAX_READ);
    fs.closeSync(fd);
    content = buf.toString("utf8");
    const firstNl = content.indexOf("\n");
    if (firstNl > 0) content = content.slice(firstNl + 1);
  } else {
    content = fs.readFileSync(file, "utf8");
  }
  const all = content.split("\n");
  result.lines = all.slice(-lines);
  return result;
}

module.exports = { readTail, logFilePath };
