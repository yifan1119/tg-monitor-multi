// web/lib/data-provider.js
//
// 資料接口層：Web 頁面只透過這個模組取數據。
//
// 模式 (env DATA_PROVIDER):
//   real  — 預設。讀真實 depts/ 目錄 + pm2.connect() (若可用)
//   mock  — 開發 / 展示 UI 用，塞 9 個假部門

const fs = require("fs");
const path = require("path");

const MODE = process.env.DATA_PROVIDER === "mock" ? "mock" : "real";
const ROOT = path.resolve(__dirname, "..", "..");

// ═════════════════════════════════════════════════════
// REAL 實作
// ═════════════════════════════════════════════════════

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listDeptDirs() {
  const deptsDir = path.join(ROOT, "depts");
  if (!fs.existsSync(deptsDir)) return [];
  return fs.readdirSync(deptsDir)
    .filter(n => {
      if (n.startsWith("_") || n.startsWith(".")) return false;
      const full = path.join(deptsDir, n);
      return fs.statSync(full).isDirectory();
    });
}

async function realListDepartments() {
  const names = listDeptDirs();
  return names.map(name => {
    const deptDir = path.join(ROOT, "depts", name);
    const config = readJsonSafe(path.join(deptDir, "config.json")) || {};
    const sessionExists = fs.existsSync(path.join(deptDir, "session.txt"));
    const sessionStat = sessionExists ? fs.statSync(path.join(deptDir, "session.txt")) : null;
    return {
      name,
      display: config.display || name,
      outputChat: config.outputChatName || "-",
      sheetId: config.spreadsheetId || "",
      sheetTab: config.sheetName || "-",
      sessionOk: sessionExists && sessionStat.size > 0,
      lastMsg: "-",
      hit24h: 0,
    };
  });
}

async function realListProcesses() {
  // pm2.connect() 在本機開發 (沒 pm2 daemon) 會 hang，加 2s timeout 保底
  try {
    const pm2 = require("pm2");
    return await Promise.race([
      new Promise((resolve) => {
        pm2.connect((err) => {
          if (err) return resolve([]);
          pm2.list((err2, list) => {
            try { pm2.disconnect(); } catch {}
            if (err2 || !list) return resolve([]);
            const procs = list
              .filter(p => p.name && p.name.startsWith("tg-"))
              .map(p => {
                const name = p.name;
                const m = name.match(/^tg-(listener|system-events|sheet-writer|title-sheet-writer|review-report-writer)-?(.+)?$/);
                const kind = m ? m[1] : "unknown";
                const dept = m && m[2] ? m[2] : "_global";
                return {
                  name,
                  dept,
                  kind,
                  status: p.pm2_env?.status || "unknown",
                  cpu: p.monit?.cpu || 0,
                  mem: Math.round((p.monit?.memory || 0) / 1024 / 1024),
                  restarts: p.pm2_env?.restart_time || 0,
                  uptime: p.pm2_env?.pm_uptime
                    ? formatUptime(Date.now() - p.pm2_env.pm_uptime)
                    : "-",
                };
              });
            resolve(procs);
          });
        });
      }),
      new Promise((resolve) => setTimeout(() => resolve([]), 2000)),
    ]);
  } catch {
    return [];
  }
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function realListAlerts() {
  // v0.3 才實作 (從 pm2 logs 抽)。空模板階段回空陣列
  return [];
}

async function realIsSetupComplete() {
  const sysPath = path.join(ROOT, "data", "system.json");
  const sys = readJsonSafe(sysPath);
  return Boolean(sys && sys.setupComplete);
}

// ═════════════════════════════════════════════════════
// MOCK 實作 (env DATA_PROVIDER=mock 才用, 開發/展示用)
// ═════════════════════════════════════════════════════

const MOCK_DEPTS = [
  { name: "yueda",       display: "悦达",     outputChat: "悦达-业务审查",     sheetId: "1Q9pMXg5I1dUDTKvuTibH7gB9vib9nZNPvNJ4cxxQiCc", sheetTab: "关键词提醒yd",   sessionOk: true,  lastMsg: "2026-04-16 20:42", hit24h: 17 },
  { name: "yipin",       display: "逸品",     outputChat: "逸品-业务审查",     sheetId: "1xXxXxXxX", sheetTab: "关键词提醒yp",   sessionOk: true,  lastMsg: "2026-04-16 20:51", hit24h: 23 },
  { name: "dingfeng",    display: "鼎丰",     outputChat: "鼎丰-业务审查",     sheetId: "1yYyYyYyY", sheetTab: "关键词提醒df",   sessionOk: true,  lastMsg: "2026-04-16 20:38", hit24h: 9 },
  { name: "linghang",    display: "领航",     outputChat: "领航-业务审查",     sheetId: "1zZzZzZzZ", sheetTab: "关键词提醒lh",   sessionOk: true,  lastMsg: "2026-04-16 20:55", hit24h: 31 },
  { name: "ruisheng",    display: "瑞升",     outputChat: "瑞升-业务审查",     sheetId: "1aAaAaAaA", sheetTab: "关键词提醒rs",   sessionOk: true,  lastMsg: "2026-04-16 19:12", hit24h: 5 },
  { name: "hengrui",     display: "恒睿",     outputChat: "恒睿-业务审查",     sheetId: "1bBbBbBbB", sheetTab: "关键词提醒hr",   sessionOk: false, lastMsg: "2026-04-15 11:04", hit24h: 0 },
  { name: "wuji",        display: "无极",     outputChat: "无极-业务审查",     sheetId: "1cCcCcCcC", sheetTab: "关键词提醒wj",   sessionOk: true,  lastMsg: "2026-04-16 20:46", hit24h: 12 },
  { name: "yipinfuhua",  display: "逸品福华", outputChat: "逸品福华-业务审查", sheetId: "1dDdDdDdD", sheetTab: "关键词提醒yf",   sessionOk: true,  lastMsg: "2026-04-16 20:33", hit24h: 8 },
  { name: "wanyouyinli", display: "万有引力", outputChat: "万有引力-业务审查", sheetId: "1eEeEeEeE", sheetTab: "关键词提醒wyyl", sessionOk: true,  lastMsg: "2026-04-16 20:58", hit24h: 14 },
];

const MOCK_PROCS = MOCK_DEPTS.flatMap((d, i) => [
  { name: `tg-listener-${d.name}`,      dept: d.name, kind: "listener",      status: "online",                        cpu: 0.4 + i * 0.1,  mem: 60 + i * 5,   restarts: 0, uptime: "4d" },
  { name: `tg-system-events-${d.name}`, dept: d.name, kind: "system-events", status: i === 5 ? "stopped" : "online",  cpu: 0.2,            mem: 50 + i * 4,   restarts: i, uptime: i === 5 ? "0s" : "37h" },
  { name: `tg-sheet-writer-${d.name}`,  dept: d.name, kind: "sheet-writer",  status: "online",                        cpu: 0.6 + i * 0.05, mem: 400 + i * 50, restarts: 0, uptime: "4d" },
]).concat([
  { name: "tg-title-sheet-writer",   dept: "_global", kind: "title-sheet-writer",   status: "online", cpu: 0.1, mem: 226, restarts: 0, uptime: "4d" },
  { name: "tg-review-report-writer", dept: "_global", kind: "review-report-writer", status: "online", cpu: 0.2, mem: 374, restarts: 0, uptime: "4d" },
]);

const MOCK_ALERTS = [
  { ts: "20:42:11", level: "warn",  dept: "hengrui", msg: "session 已斷線 30+ 分鐘，需要重新登入" },
  { ts: "20:38:02", level: "info",  dept: "yueda",   msg: "命中關鍵字「到期」× 3" },
  { ts: "19:22:18", level: "error", dept: "hengrui", msg: "Telegram auth error: AUTH_KEY_UNREGISTERED" },
];

// ═════════════════════════════════════════════════════
// 公開介面
// ═════════════════════════════════════════════════════

async function listDepartments() {
  return MODE === "mock" ? MOCK_DEPTS : await realListDepartments();
}

async function listProcesses() {
  return MODE === "mock" ? MOCK_PROCS : await realListProcesses();
}

async function listAlerts() {
  return MODE === "mock" ? MOCK_ALERTS : await realListAlerts();
}

async function getSystemSummary() {
  const depts = await listDepartments();
  const procs = await listProcesses();
  return {
    version: "0.2.0-mvp-dev",
    mode: MODE,
    deptCount: depts.length,
    procTotal: procs.length,
    procOnline: procs.filter(p => p.status === "online").length,
    procOffline: procs.filter(p => p.status !== "online").length,
    totalHit24h: depts.reduce((a, d) => a + (d.hit24h || 0), 0),
    sessionBroken: depts.filter(d => !d.sessionOk).length,
  };
}

async function isSetupComplete() {
  if (MODE === "mock") return true; // mock 假設已完成 setup
  return await realIsSetupComplete();
}

module.exports = {
  MODE,
  ROOT,
  listDepartments,
  listProcesses,
  listAlerts,
  getSystemSummary,
  isSetupComplete,
};
