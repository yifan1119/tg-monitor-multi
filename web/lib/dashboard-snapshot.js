// web/lib/dashboard-snapshot.js
//
// 单一聚合接口 — 给 Dashboard HTML 和 /api/v1/metrics JSON 共用
//
// Schema 照姊妹项目 tg-monitor-template 的 snapshot() 对齐, 加 product 字段区分.
// 中央看板拿 product 决定怎么渲染 (multi 是部门, template 是账号).

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const VERSION_FILE = path.join(ROOT, "VERSION");
const DATA_DIR = path.join(ROOT, "data");
const SYSTEM_JSON = path.join(DATA_DIR, "system.json");

const dataProvider = require("./data-provider");
const updateManager = require("./update-manager");

function nowBJ() {
  // 北京时间 ISO (YYYY-MM-DD HH:MM:SS), 对齐姊妹项目
  return new Date().toLocaleString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).replace(/\//g, "-");
}

function readVersion() {
  try { return fs.readFileSync(VERSION_FILE, "utf8").trim(); } catch { return "?"; }
}

function readSystem() {
  try { return JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")); } catch { return {}; }
}

// 心跳分级: online (有 proc 在跑) / warn (有 session 但 proc 没跑) / dead (session 坏)
function classifyDept(dept, procs) {
  if (!dept.sessionOk) return "dead";
  const workerName = `tg-worker-${dept.name}`;
  const proc = procs.find(p => p.name === workerName);
  if (proc && proc.status === "online") return "online";
  return "warn";
}

async function snapshot() {
  const [depts, procs, alerts] = await Promise.all([
    dataProvider.listDepartments(),
    dataProvider.listProcesses(),
    dataProvider.listAlerts(),
  ]);

  // 部门矩阵 — 对齐 template 的 "accounts" 字段名
  const accounts = depts.map(d => {
    const status = classifyDept(d, procs);
    return {
      name: d.name,
      display: d.display,
      heartbeat_status: status,      // online / warn / dead
      session_ok: !!d.sessionOk,
      output_chat: d.outputChat || "",
      sheet_id: d.sheetId || "",
      sheet_tab: d.sheetTab || "",
      last_message: d.lastMsg || null,
      hit_24h: d.hit24h || 0,
    };
  });

  const online = accounts.filter(a => a.heartbeat_status === "online").length;
  const warn = accounts.filter(a => a.heartbeat_status === "warn").length;
  const dead = accounts.filter(a => a.heartbeat_status === "dead").length;

  const totalHit24h = accounts.reduce((a, b) => a + (b.hit_24h || 0), 0);

  // 最近告警 (已经是 alerts 的样子, 直接出)
  const alertsRecent = (alerts || []).slice(0, 50).map(a => ({
    ts: a.ts || a.createdAt || "",
    dept: a.dept || "",
    source_group: a.sourceGroup || "",
    sender: a.senderName || "",
    keyword: a.keyword || "",
    content: a.messageContent || "",
  }));

  // 升级状态 — 软失败 fallback
  let update = { has_update: false };
  try {
    const u = updateManager.checkUpdates();
    if (u.ok) {
      update = {
        has_update: u.behind > 0,
        behind: u.behind,
        current_commit: u.currentCommit,
        current_msg: u.currentMsg,
        commits: u.commits || [],
        needs_image: !!u.needsImage,
      };
    }
  } catch { /* git fetch fail 不影响 metrics */ }

  const sys = readSystem();

  return {
    ok: true,
    ts: nowBJ(),
    product: "tg-monitor-multi",
    instance: process.env.INSTANCE || "",
    version: readVersion(),
    company: {
      name: sys.companyName || "",
      display: sys.companyDisplay || "",
    },
    system: {
      listener_online: online,
      listener_warn: warn,
      listener_dead: dead,
      listener_total: accounts.length,
    },
    alerts_today: {
      total: totalHit24h,      // 24h 命中, 近似今日
      keyword: totalHit24h,
      title_change: 0,          // 未单独追踪, 先 0
    },
    accounts,
    alerts_recent: alertsRecent,
    update,
  };
}

module.exports = { snapshot };
