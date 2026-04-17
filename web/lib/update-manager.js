// web/lib/update-manager.js
//
// 升级 / 回滚管理 (Web 层, 同步执行短任务)
//
// 策略:
//   - 软升级 = git pull + regen ecosystem + pm2 reload tg-* (不重建容器/不动 web 自己)
//   - 硬升级 (Dockerfile / package.json 变动) → 不做, 指引用户 SSH 到宿主机
//   - 回滚 = 恢复 depts/global/data/secrets + regen + reload
//
// 所有操作都会事先备份到 .backups/<ts>/ (符合 R5 可回滚契约)

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const BACKUPS_DIR = path.join(ROOT, ".backups");
const TRASH_DIR = path.join(ROOT, ".trash");

// 这些文件改变 = 真的需要重建 Docker 镜像 (依赖/基础镜像变动)
// package.json 不在此 — 可能只是 version 改, 用 isPackageJsonSafe 判断
const HARD_UPDATE_PATTERNS = [
  /^Dockerfile$/,
  /^docker-compose\.yml$/,
  /^package-lock\.json$/,
  /^web\/package-lock\.json$/,
  /^shared\/package-lock\.json$/,
];

// package.json 变动: 若 diff 只改了 "version" 字段, 视为软升级 OK
function isPackageJsonSafe(file) {
  try {
    const diff = execFileSync("git", ["diff", "HEAD..origin/main", "--", file], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString();
    // 扫 diff 的 +/- 行, 若全部改动只命中 "version" 字段, 就是安全的版本号升级
    const changedLines = diff.split("\n").filter(l => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));
    if (changedLines.length === 0) return true;
    return changedLines.every(l => /"version"\s*:/.test(l));
  } catch { return false; }
}

// 需要 pm2 reload 的进程前缀 (故意排除 tg-monitor-web)
const RELOAD_PREFIXES = [
  "tg-listener-",
  "tg-system-events-",
  "tg-sheet-writer-",
  "tg-title-sheet-writer",
  "tg-review-report-writer",
];

function tsNow() {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15); // YYYYMMDDHHMMSS
}

function runCaptured(cmd, args, log) {
  log.push(`$ ${cmd} ${args.join(" ")}`);
  try {
    const out = execFileSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    if (out) log.push(out);
    return { ok: true, out };
  } catch (e) {
    const err = (e.stderr ? e.stderr.toString() : "") || e.message;
    log.push(`✗ ${err.trim()}`);
    return { ok: false, err };
  }
}

function checkUpdates() {
  try {
    execFileSync("git", ["fetch", "origin"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const behind = execFileSync("git", ["rev-list", "--count", "HEAD..origin/main"], { cwd: ROOT }).toString().trim();
    const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
    const currentMsg = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: ROOT }).toString().trim();
    let commits = [], changedFiles = [];
    if (behind !== "0") {
      commits = execFileSync("git", ["log", "--oneline", "HEAD..origin/main"], { cwd: ROOT })
        .toString().trim().split("\n").filter(Boolean);
      changedFiles = execFileSync("git", ["diff", "--name-only", "HEAD..origin/main"], { cwd: ROOT })
        .toString().trim().split("\n").filter(Boolean);
    }
    // 判断是否需要重建镜像:
    // 1. HARD_UPDATE_PATTERNS 命中 (Dockerfile / lock 文件)
    // 2. package.json 变了且不只是 version 字段
    const hardHits = changedFiles.filter(f => HARD_UPDATE_PATTERNS.some(p => p.test(f)));
    const pkgChanges = changedFiles.filter(f => /^(web\/|shared\/)?package\.json$/.test(f));
    const unsafePkgChanges = pkgChanges.filter(f => !isPackageJsonSafe(f));
    const needsImage = hardHits.length > 0 || unsafePkgChanges.length > 0;
    return {
      ok: true,
      behind: Number(behind),
      currentCommit: current.slice(0, 8),
      currentMsg,
      commits,
      changedFiles,
      needsImage,
      // 宿主机路径: 容器内 ROOT=/app, 对用户没用; 从 env 读 (docker-compose 传进来),
      // fallback 到 install.sh 默认的 /opt/tg-monitor-multi
      rootPath: process.env.HOST_INSTALL_DIR || (process.env.TG_MONITOR_MULTI_DOCKER ? "/opt/tg-monitor-multi" : ROOT),
    };
  } catch (e) {
    return { ok: false, error: e.stderr ? e.stderr.toString() : e.message };
  }
}

function makeBackup(log) {
  const ts = tsNow();
  const bk = path.join(BACKUPS_DIR, ts);
  fs.mkdirSync(bk, { recursive: true });
  for (const d of ["depts", "global", "data", "secrets"]) {
    const src = path.join(ROOT, d);
    if (!fs.existsSync(src)) continue;
    try {
      execFileSync("cp", ["-r", src, bk], { cwd: ROOT });
      log.push(`✓ 备份 ${d}/`);
    } catch (e) {
      log.push(`⚠ 备份 ${d}/ 失败: ${e.message}`);
    }
  }
  log.push(`✓ 备份完成: .backups/${ts}/`);
  return ts;
}

function reloadAllTgProcs(log) {
  for (const prefix of RELOAD_PREFIXES) {
    const glob = prefix.endsWith("-") ? `${prefix}*` : prefix;
    try {
      const out = execFileSync("pm2", ["reload", glob], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString();
      const lastLine = out.trim().split("\n").slice(-1)[0] || "";
      log.push(`✓ pm2 reload ${glob} — ${lastLine.slice(0, 80)}`);
    } catch (e) {
      // glob 没匹配到进程 pm2 会报错, 忽略
      log.push(`· pm2 reload ${glob}: 无进程或已报错 (忽略)`);
    }
  }
}

function softUpdate() {
  const log = [];
  log.push(`[${new Date().toISOString()}] === 软升级开始 ===`);

  // 1. 先检查
  const check = checkUpdates();
  if (!check.ok) {
    throw new Error(`git fetch 失败: ${check.error}`);
  }
  if (check.behind === 0) {
    log.push("✓ 已是最新, 无需升级");
    return { ok: true, noop: true, log: log.join("\n") };
  }
  if (check.needsImage) {
    throw new Error(
      `此升级涉及 Dockerfile / package.json 变动, Web 搞不定.\n` +
      `请 SSH 到宿主机跑: \`bash scripts/update.sh\`\n` +
      `变动文件: ${check.changedFiles.filter(f => HARD_UPDATE_PATTERNS.some(p => p.test(f))).join(", ")}`
    );
  }

  log.push(`即将应用 ${check.behind} 个 commit:`);
  check.commits.slice(0, 10).forEach(c => log.push(`  • ${c}`));

  // 2. 备份
  const bkTs = makeBackup(log);

  // 3. git pull
  const pull = runCaptured("git", ["pull", "--ff-only", "origin", "main"], log);
  if (!pull.ok) throw new Error(`git pull 失败 (已备份到 ${bkTs}): ${pull.err}`);

  // 4. regen ecosystem
  const regen = runCaptured("node", ["scripts/generate-ecosystem.js"], log);
  if (!regen.ok) log.push(`⚠ ecosystem 重生失败, 但 git pull 已完成`);

  // 5. reload tg-* (不含 web)
  reloadAllTgProcs(log);

  log.push(`[${new Date().toISOString()}] ✅ 软升级完成`);
  return { ok: true, log: log.join("\n"), backupTs: bkTs };
}

function rollback(backupTs) {
  const log = [];
  log.push(`[${new Date().toISOString()}] === 回滚开始 → .backups/${backupTs} ===`);

  const bk = path.join(BACKUPS_DIR, backupTs);
  if (!fs.existsSync(bk)) throw new Error(`备份不存在: .backups/${backupTs}`);

  // 1. 预备份当前 (万一回滚也出错)
  const safetyTs = tsNow() + "-pre-rollback";
  const safety = path.join(BACKUPS_DIR, safetyTs);
  fs.mkdirSync(safety, { recursive: true });
  for (const d of ["depts", "global", "data", "secrets"]) {
    const src = path.join(ROOT, d);
    if (!fs.existsSync(src)) continue;
    try { execFileSync("cp", ["-r", src, safety], { cwd: ROOT }); } catch {}
  }
  log.push(`✓ 预备份当前状态到 .backups/${safetyTs}/ (万一回滚也坏)`);

  // 2. 恢复
  for (const d of ["depts", "global", "data", "secrets"]) {
    const src = path.join(bk, d);
    const dst = path.join(ROOT, d);
    if (!fs.existsSync(src)) {
      log.push(`· ${d}/ 不在备份里, 跳过`);
      continue;
    }
    if (fs.existsSync(dst)) {
      fs.rmSync(dst, { recursive: true, force: true });
    }
    execFileSync("cp", ["-r", src, dst], { cwd: ROOT });
    log.push(`✓ 恢复 ${d}/`);
  }

  // 3. 重生 ecosystem + reload
  runCaptured("node", ["scripts/generate-ecosystem.js"], log);
  reloadAllTgProcs(log);

  log.push(`[${new Date().toISOString()}] ✅ 回滚完成`);
  return { ok: true, log: log.join("\n"), safetyTs };
}

function listBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs.readdirSync(BACKUPS_DIR)
    .filter(n => !n.startsWith(".") && fs.statSync(path.join(BACKUPS_DIR, n)).isDirectory())
    .map(n => {
      const p = path.join(BACKUPS_DIR, n);
      const st = fs.statSync(p);
      let sub = [];
      try { sub = fs.readdirSync(p).filter(x => !x.startsWith(".")); } catch {}
      let sizeKb = 0;
      try {
        const s = execFileSync("du", ["-sk", p], { cwd: ROOT }).toString().trim().split(/\s+/)[0];
        sizeKb = Number(s) || 0;
      } catch {}
      const sizeStr = sizeKb > 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb} KB`;
      return {
        ts: n,
        mtime: st.mtime.toISOString(),
        includes: sub,
        sizeStr,
        isSafety: n.endsWith("-pre-rollback"),
      };
    })
    .sort((a, b) => b.ts.localeCompare(a.ts));
}

module.exports = { checkUpdates, softUpdate, rollback, listBackups };
