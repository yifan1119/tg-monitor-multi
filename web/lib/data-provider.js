// web/lib/data-provider.js
//
// 資料接口層：Web 頁面只透過這個模組取數據。
// MVP 先用 MOCK 數據讓 UI 跑起來，D2 完成後把 MOCK 實作換成 real（讀 depts/ 目錄 + pm2.connect()）
// UI 和 routes 不用改。
//
// 透過 env DATA_PROVIDER=mock|real 切換（預設 mock）。

const fs = require("fs");
const path = require("path");

const MODE = process.env.DATA_PROVIDER || "mock";
const ROOT = path.resolve(__dirname, "..", "..");

// ─── MOCK 實作 ─────────────────────────────────────────
const MOCK_DEPTS = [
  { name: "yueda",        display: "悦达",       outputChat: "悦达-业务审查",     sheetId: "1Q9pMXg5I1dUDTKvuTibH7gB9vib9nZNPvNJ4cxxQiCc", sheetTab: "关键词提醒yd",  sessionOk: true,  lastMsg: "2026-04-16 20:42", hit24h: 17 },
  { name: "yipin",        display: "逸品",       outputChat: "逸品-业务审查",     sheetId: "1xXxXxXxX", sheetTab: "关键词提醒yp", sessionOk: true,  lastMsg: "2026-04-16 20:51", hit24h: 23 },
  { name: "dingfeng",     display: "鼎丰",       outputChat: "鼎丰-业务审查",     sheetId: "1yYyYyYyY", sheetTab: "关键词提醒df", sessionOk: true,  lastMsg: "2026-04-16 20:38", hit24h: 9 },
  { name: "linghang",     display: "领航",       outputChat: "领航-业务审查",     sheetId: "1zZzZzZzZ", sheetTab: "关键词提醒lh", sessionOk: true,  lastMsg: "2026-04-16 20:55", hit24h: 31 },
  { name: "ruisheng",     display: "瑞升",       outputChat: "瑞升-业务审查",     sheetId: "1aAaAaAaA", sheetTab: "关键词提醒rs", sessionOk: true,  lastMsg: "2026-04-16 19:12", hit24h: 5 },
  { name: "hengrui",      display: "恒睿",       outputChat: "恒睿-业务审查",     sheetId: "1bBbBbBbB", sheetTab: "关键词提醒hr", sessionOk: false, lastMsg: "2026-04-15 11:04", hit24h: 0 },
  { name: "wuji",         display: "无极",       outputChat: "无极-业务审查",     sheetId: "1cCcCcCcC", sheetTab: "关键词提醒wj", sessionOk: true,  lastMsg: "2026-04-16 20:46", hit24h: 12 },
  { name: "yipinfuhua",   display: "逸品福华",   outputChat: "逸品福华-业务审查", sheetId: "1dDdDdDdD", sheetTab: "关键词提醒yf", sessionOk: true,  lastMsg: "2026-04-16 20:33", hit24h: 8 },
  { name: "wanyouyinli",  display: "万有引力",   outputChat: "万有引力-业务审查", sheetId: "1eEeEeEeE", sheetTab: "关键词提醒wyyl",sessionOk: true,  lastMsg: "2026-04-16 20:58", hit24h: 14 },
];

const MOCK_PROCS = MOCK_DEPTS.flatMap((d, i) => [
  { name: `tg-listener-${d.name}`,       dept: d.name, kind: "listener",      status: "online",  cpu: 0.4 + i * 0.1, mem: 60 + i * 5, restarts: 0, uptime: "4D" },
  { name: `tg-system-events-${d.name}`,  dept: d.name, kind: "system-events", status: i === 5 ? "stopped" : "online", cpu: 0.2, mem: 50 + i * 4, restarts: i, uptime: i === 5 ? "0" : "37h" },
  { name: `tg-sheet-writer-${d.name}`,   dept: d.name, kind: "sheet-writer",  status: "online",  cpu: 0.6 + i * 0.05, mem: 400 + i * 50, restarts: 0, uptime: "4D" },
]).concat([
  { name: "tg-title-sheet-writer",    dept: "_global", kind: "title-sheet-writer",    status: "online", cpu: 0.1, mem: 226, restarts: 0, uptime: "4D" },
  { name: "tg-review-report-writer",  dept: "_global", kind: "review-report-writer",  status: "online", cpu: 0.2, mem: 374, restarts: 0, uptime: "4D" },
]);

const MOCK_ALERTS = [
  { ts: "20:42:11", level: "warn",  dept: "hengrui", msg: "session 已斷線 30+ 分鐘，需要重新登入" },
  { ts: "20:38:02", level: "info",  dept: "yueda",   msg: "命中關鍵字「到期」× 3" },
  { ts: "20:33:54", level: "info",  dept: "dingfeng",msg: "群名變更：yipin-客戶47 → yipin-客戶47-暂停" },
  { ts: "19:22:18", level: "error", dept: "hengrui", msg: "Telegram auth error: AUTH_KEY_UNREGISTERED" },
];

// ─── 介面 ─────────────────────────────────────────────
async function listDepartments() {
  if (MODE === "mock") return MOCK_DEPTS;
  // REAL: 掃 depts/ 目錄
  const deptsDir = path.join(ROOT, "depts");
  if (!fs.existsSync(deptsDir)) return [];
  return fs.readdirSync(deptsDir)
    .filter(n => !n.startsWith("_") && !n.startsWith(".") && fs.statSync(path.join(deptsDir, n)).isDirectory())
    .map(n => {
      const config = JSON.parse(fs.readFileSync(path.join(deptsDir, n, "config.json"), "utf8"));
      const sessionExists = fs.existsSync(path.join(deptsDir, n, "session.txt"));
      return {
        name: n,
        display: n,
        outputChat: config.outputChatName,
        sheetId: config.spreadsheetId,
        sheetTab: config.sheetName,
        sessionOk: sessionExists,
        lastMsg: "-",
        hit24h: 0,
      };
    });
}

async function listProcesses() {
  if (MODE === "mock") return MOCK_PROCS;
  // REAL: 透過 pm2.connect() 讀 (D4 填實)
  return [];
}

async function listAlerts() {
  if (MODE === "mock") return MOCK_ALERTS;
  return [];
}

async function getSystemSummary() {
  const depts = await listDepartments();
  const procs = await listProcesses();
  return {
    version: process.env.npm_package_version || "0.2.0-mvp-dev",
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
  if (MODE === "mock") return false; // 首次進入給 mock 看 setup wizard
  // REAL: 檢查 data/system.json 的 setupComplete
  const p = path.join(ROOT, "data", "system.json");
  if (!fs.existsSync(p)) return false;
  try {
    return Boolean(JSON.parse(fs.readFileSync(p, "utf8")).setupComplete);
  } catch { return false; }
}

module.exports = {
  MODE,
  listDepartments,
  listProcesses,
  listAlerts,
  getSystemSummary,
  isSetupComplete,
};
