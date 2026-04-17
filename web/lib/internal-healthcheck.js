// web/lib/internal-healthcheck.js
//
// Web 内置健康检查: 每 5 分钟扫一次所有 tg-* 进程, 非 online 的 pm2 restart.
// 在 Docker 模式下代替 crontab 方案 (容器里没跑 crond, cron 写了也不执行).
// 开关存 data/system.json 的 healthcheckEnabled 字段, Web 启动时读一次.
//
// 跟 scripts/healthcheck.sh 一样的策略:
//   - 跳过 listener (重启会掉 TG session)
//   - 跳过 tg-monitor-web (self-restart 会断 Web UI)
//   - 跳过 waiting restart 状态 (pm2 已经在处理)

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const SYSTEM_JSON = path.join(ROOT, "data", "system.json");
const LOG_FILE = path.join(ROOT, ".healthcheck", "healthcheck.log");
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const SKIP_PROCESS_PATTERNS = [
  /^tg-listener-/,  // listener 重启掉 TG session
  /^tg-worker-/,    // v0.4: worker 包含 listener, 同理不重启
  /^tg-monitor-web$/, // self-restart = 断 Web UI
];

let timer = null;

function readEnabled() {
  try {
    const sys = JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8"));
    return Boolean(sys.healthcheckEnabled);
  } catch { return false; }
}

function setEnabled(enabled) {
  let sys = {};
  try { sys = JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")); } catch {}
  sys.healthcheckEnabled = Boolean(enabled);
  if (!fs.existsSync(path.dirname(SYSTEM_JSON))) fs.mkdirSync(path.dirname(SYSTEM_JSON), { recursive: true });
  fs.writeFileSync(SYSTEM_JSON, JSON.stringify(sys, null, 2));
  if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    // 日志轮替: 大于 5MB 就切
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + ".1");
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
  console.log(`[healthcheck] ${msg}`);
}

async function pm2List() {
  return new Promise((resolve) => {
    execFile("pm2", ["jlist"], { cwd: ROOT }, (err, stdout) => {
      if (err) return resolve([]);
      try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
    });
  });
}

async function pm2Restart(name) {
  return new Promise((resolve) => {
    execFile("pm2", ["restart", name], { cwd: ROOT }, (err, _o, stderr) => {
      resolve({ ok: !err, err: err ? stderr : "" });
    });
  });
}

async function runCheck() {
  if (!readEnabled()) return;
  const list = await pm2List();
  const tgProcs = list.filter(p => p.name && p.name.startsWith("tg-"));
  for (const p of tgProcs) {
    const name = p.name;
    const status = p.pm2_env?.status;
    if (status === "online") continue;
    if (SKIP_PROCESS_PATTERNS.some(rx => rx.test(name))) continue;
    logLine(`${name} status=${status}, pm2 restart...`);
    const r = await pm2Restart(name);
    logLine(`  → ${r.ok ? "OK" : "FAIL: " + r.err}`);
  }
}

function start() {
  if (timer) return;
  // 启动后立刻跑一次, 之后每 5 分钟
  runCheck().catch(() => {});
  timer = setInterval(() => runCheck().catch(() => {}), CHECK_INTERVAL_MS);
  timer.unref();
  logLine("内置健康检查定时器已启动 (5 min 间隔)");
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  logLine("内置健康检查定时器已停止");
}

// Web 启动时调一次: 若 system.json 说 enabled, 就开始跑
function bootstrap() {
  if (readEnabled()) start();
}

module.exports = { setEnabled, readEnabled, start, stop, bootstrap, LOG_FILE };
