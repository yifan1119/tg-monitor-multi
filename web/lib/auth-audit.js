// web/lib/auth-audit.js
//
// append-only JSONL 审计日志. 登入成功 / 失败 / 改密 / 重置 / 绑定 TG 都记一笔.
// 日志: data/auth-audit.log
// 单行 JSON 对象: { ts, event, ...detail }

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT, "data");
const LOG_FILE = path.join(DATA_DIR, "auth-audit.log");
const MAX_BYTES = 2 * 1024 * 1024; // 2MB 切一下
const KEEP_LINES = 2000;

function log(event, detail = {}) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const entry = { ts: new Date().toISOString(), event, ...detail };
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
    // 简单 rotate
    const st = fs.statSync(LOG_FILE);
    if (st.size > MAX_BYTES) {
      const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n");
      fs.writeFileSync(LOG_FILE, lines.slice(-KEEP_LINES).join("\n") + "\n");
    }
  } catch (e) { /* 审计失败不影响主流程 */ }
}

function read(n = 50) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).reverse();
  } catch { return []; }
}

module.exports = { log, read };
