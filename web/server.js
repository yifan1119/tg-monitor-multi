// tg-monitor-multi — Web Dashboard
// v0.2.0-mvp 预览版 (D3+D4 合并推进)
//
// 启动：
//   cd web && npm install && npm start
//   浏览 http://localhost:5003
//
// 资料源：预设 mock，环境变数 DATA_PROVIDER=real 切到实际 pm2+depts/

const express = require("express");
const expressLayouts = require("express-ejs-layouts");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const dataProvider = require("./lib/data-provider");
const { createDept, validateDeptName } = require("../scripts/new-dept");
const { createGlobal, listGlobals, KINDS: GLOBAL_KINDS } = require("../scripts/new-global");
const auth = require("./lib/auth");
const authAudit = require("./lib/auth-audit");
const adminReset = require("./lib/admin-reset");
const adminBot = require("./lib/tg-admin-bot");
const sessionWatcher = require("./lib/session-watcher");

// multer: 处理 multipart/form-data (档案上传). 内存储存, 200KB 上限 (Google SA JSON 通常 ~2KB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 },
});

const app = express();
const PORT = Number(process.env.PORT || 5003);
const ROOT = path.resolve(__dirname, "..");
const VERSION = require("../package.json").version;
const DATA_DIR = path.join(ROOT, "data");
const SYSTEM_JSON = path.join(DATA_DIR, "system.json");
const GOOGLE_SA_PATH = path.join(ROOT, "shared", "google-service-account.json");

// ─── View Engine ──────────────────────────────────────
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "templates"));
app.use(expressLayouts);
app.set("layout", "partials/layout");
app.set("layout extractScripts", true);

// ─── 静态 / body parser ──────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ─── 全域 locals ─────────────────────────────────────
app.use((req, res, next) => {
  res.locals.version = VERSION;
  res.locals.mode = dataProvider.MODE;
  res.locals.active = "";
  res.locals.showNav = true;
  res.locals.currentUser = auth.getCurrentUser(req);
  next();
});

// ─── 登入守卫 (必须在所有路由前挂) ───────────────────
app.use(auth.requireLogin);

// ─── 辅助: 呼叫 scripts/generate-ecosystem.js ────────
function regenerateEcosystem() {
  return new Promise((resolve) => {
    const script = path.join(ROOT, "scripts", "generate-ecosystem.js");
    execFile("node", [script], { cwd: ROOT }, (err, stdout, stderr) => {
      if (err) console.error("[ecosystem] regenerate failed:", stderr || err.message);
      else console.log("[ecosystem]", stdout.trim());
      resolve();
    });
  });
}

// ═════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════

// ─── 根路径 → 自动判断去哪 ───────────────────────────
app.get("/", async (_req, res) => {
  const complete = await dataProvider.isSetupComplete();
  res.redirect(complete ? "/dashboard" : "/setup");
});

// ─── 健康检查 API ────────────────────────────────────
app.get("/health", async (_req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    mode: dataProvider.MODE,
    time: new Date().toISOString(),
  });
});

// ─── 登入 ────────────────────────────────────────────
app.get("/login", (req, res) => {
  res.render("pages/login", {
    title: "登入",
    showNav: false,
    layout: false,
    error: req.query.error || null,
    next: req.query.next || "",
  });
});

app.post("/login", (req, res) => {
  const ip = auth.clientIp(req);
  const { username = "", password = "", next: nextUrl = "" } = req.body || {};

  // IP 锁定
  const lockMs = auth.lockoutRemainingMs(ip);
  if (lockMs > 0) {
    authAudit.log("login_locked", { ip, username, unlock_in_sec: Math.ceil(lockMs / 1000) });
    return res.render("pages/login", {
      title: "登入", showNav: false, layout: false, next: nextUrl,
      error: `此 IP 暂时被锁定, 剩 ${Math.ceil(lockMs / 1000)}s`,
    });
  }

  const sys = (() => { try { return JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")); } catch { return {}; } })();
  const hash = sys.adminPasswordHash;
  const expectedUser = sys.adminUsername || "admin";

  let ok = false;
  if (username === expectedUser && hash) {
    ok = auth.verifyPassword(password, hash);
  }
  // 旧明文 adminPassword 的迁移路径: 首次匹配后把它 hash 掉
  if (!ok && sys.adminPassword && username === expectedUser && password === sys.adminPassword) {
    sys.adminPasswordHash = auth.hashPassword(password);
    delete sys.adminPassword;
    try { fs.writeFileSync(SYSTEM_JSON, JSON.stringify(sys, null, 2)); } catch {}
    ok = true;
  }

  auth.recordLoginAttempt(ip, ok);
  authAudit.log(ok ? "login_success" : "login_fail", { ip, username });
  if (!ok) {
    const fails = auth.failuresInWindow(ip);
    return res.render("pages/login", {
      title: "登入", showNav: false, layout: false, next: nextUrl,
      error: `用户名或密码错误${fails >= 3 ? ` (再错 ${auth.MAX_ATTEMPTS - fails} 次此 IP 会被锁 15 分钟)` : ""}`,
    });
  }

  auth.setAuthCookie(res, username);
  const redirectTo = (nextUrl && nextUrl.startsWith("/") && !nextUrl.startsWith("//")) ? nextUrl : "/dashboard";
  res.redirect(redirectTo);
});

app.get("/logout", (req, res) => {
  const me = auth.getCurrentUser(req);
  if (me) authAudit.log("logout", { ip: auth.clientIp(req), username: me.username });
  auth.clearAuthCookie(res);
  res.redirect("/login");
});

// ─── 忘记密码 ────────────────────────────────────────
app.get("/forgot-password", (req, res) => {
  res.render("pages/forgot-password", {
    title: "忘记密码", showNav: false, layout: false,
    stage: "request", error: req.query.error || null, flash: req.query.flash || null,
    username: req.query.username || "",
  });
});

app.post("/api/auth/forgot_password", async (req, res) => {
  const ip = auth.clientIp(req);
  if (auth.lockoutRemainingMs(ip) > 0) {
    return res.status(429).json({ ok: false, error: "此 IP 暂时锁定, 请稍后再试" });
  }
  const username = String((req.body && req.body.username) || "").trim();
  if (!username) return res.json({ ok: false, error: "请输入用户名" });

  const sys = (() => { try { return JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")); } catch { return {}; } })();

  // 防枚举: 无论用户是否存在 / 是否绑定 TG 都返 ok:true. 真正发码只在满足条件时.
  if (sys.adminUsername !== username || !sys.adminTgUserId) {
    auth.recordLoginAttempt(ip, false);
    authAudit.log("reset_request_unbound", { ip, username, reason: sys.adminUsername !== username ? "no_user" : "not_bound" });
    return res.json({ ok: true });
  }

  const code = adminReset.createResetPending(username);
  if (code === null) {
    return res.json({ ok: false, error: "请求过于频繁, 60 秒后再试" });
  }
  const r = await adminBot.sendResetCode(sys.adminTgUserId, code);
  authAudit.log("reset_request_sent", { ip, username, tg_user_id: sys.adminTgUserId, dm_sent: r.ok });
  if (!r.ok) {
    return res.json({ ok: false, error: "发送失败: " + (r.error || "bot 未就绪. 确认已在 TG 里给 bot 发过 /start") });
  }
  res.json({ ok: true });
});

app.post("/api/auth/reset_password", (req, res) => {
  const ip = auth.clientIp(req);
  if (auth.lockoutRemainingMs(ip) > 0) {
    return res.status(429).json({ ok: false, error: "此 IP 暂时锁定" });
  }
  const { username = "", code = "", new_password = "" } = req.body || {};
  const u = String(username).trim();
  const c = String(code).trim();
  const p = String(new_password);
  if (!u || !c || !p) return res.json({ ok: false, error: "参数不完整" });
  if (p.length < 8) return res.json({ ok: false, error: "新密码至少 8 位" });

  const r = adminReset.consumeResetCode(c, u);
  if (!r.ok) {
    auth.recordLoginAttempt(ip, false);
    authAudit.log("reset_fail", { ip, username: u, reason: r.reason });
    const msg = { no_pending: "没有待处理的重置请求, 请先走「忘记密码」", used: "验证码已用过", too_many_attempts: "错误太多, 请重新申请", wrong_code: `验证码错误${r.attempts_left ? ` (还剩 ${r.attempts_left} 次)` : ""}` }[r.reason] || "验证码无效";
    return res.json({ ok: false, error: msg });
  }

  const sys = (() => { try { return JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")); } catch { return {}; } })();
  if (sys.adminUsername !== u) {
    authAudit.log("reset_fail_nouser", { ip, username: u });
    return res.json({ ok: false, error: "账号不存在" });
  }
  sys.adminPasswordHash = auth.hashPassword(p);
  delete sys.adminPassword;
  try { fs.writeFileSync(SYSTEM_JSON, JSON.stringify(sys, null, 2)); } catch (e) {
    return res.status(500).json({ ok: false, error: "写入失败: " + e.message });
  }
  auth.recordLoginAttempt(ip, true);
  authAudit.log("reset_success", { ip, username: u });
  res.json({ ok: true });
});

// ─── Setup Wizard ────────────────────────────────────
function renderSetup(res, { error = null, formData = {} } = {}, status = 200) {
  const saExists = fs.existsSync(GOOGLE_SA_PATH);
  let saInfo = null;
  if (saExists) {
    try {
      const sa = JSON.parse(fs.readFileSync(GOOGLE_SA_PATH, "utf8"));
      saInfo = { clientEmail: sa.client_email || "(未知)", projectId: sa.project_id || "" };
    } catch { /* 解析失败也显示档案存在但结构坏 */ }
  }
  res.status(status).render("pages/setup", {
    title: "首次设置",
    showNav: false,
    active: "",
    error,
    formData,
    saExists,
    saInfo,
  });
}

app.get("/setup", (_req, res) => {
  renderSetup(res);
});

// 处理 google_sa 档案上传 (单档, field name = google_sa)
app.post("/setup", upload.single("google_sa"), async (req, res) => {
  // 第 1 批: 先验证 → 通过才写档 + 建部门 + 重生 ecosystem
  const {
    admin_username, admin_password,
    tg_api_id, tg_api_hash,
    dept_name, dept_display, output_chat, spreadsheet_id, sheet_tab,
  } = req.body;

  const formData = {
    admin_username, tg_api_id, tg_api_hash,
    dept_name, dept_display, output_chat, spreadsheet_id, sheet_tab,
  };

  try {
    // 0a. 若有填部门, 先验 dept_name
    if (dept_name) {
      const v = validateDeptName(dept_name.trim());
      if (!v.ok) {
        return renderSetup(res, { error: `部门代号: ${v.reason}`, formData }, 400);
      }
    }

    // 0b. 若有上传 Google SA 档, 先验 JSON 结构
    if (req.file && req.file.buffer) {
      let parsed;
      try {
        parsed = JSON.parse(req.file.buffer.toString("utf8"));
      } catch {
        return renderSetup(res, { error: "Google SA 档案不是有效 JSON", formData }, 400);
      }
      if (!parsed.type || parsed.type !== "service_account" || !parsed.client_email || !parsed.private_key) {
        return renderSetup(res, {
          error: "Google SA 档案结构不对: 缺少 type/client_email/private_key. 请从 GCP Console → IAM → Service Accounts 下载 JSON key.",
          formData,
        }, 400);
      }
      // 验证通过, 写到 shared/
      fs.writeFileSync(GOOGLE_SA_PATH, req.file.buffer.toString("utf8"));
      console.log(`[setup] Google SA 已保存: ${parsed.client_email}`);
    }

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // 1. 写 system.json
    const sys = fs.existsSync(SYSTEM_JSON)
      ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8"))
      : {};
    Object.assign(sys, {
      setupComplete: true,
      setupAt: new Date().toISOString(),
      adminUsername: admin_username || "admin",
      tgApiId: tg_api_id || sys.tgApiId || "",
      tgApiHash: tg_api_hash || sys.tgApiHash || "",
    });
    if (admin_password) {
      sys.adminPasswordHash = auth.hashPassword(admin_password);
      delete sys.adminPassword; // 旧字段清掉
    }
    fs.writeFileSync(SYSTEM_JSON, JSON.stringify(sys, null, 2));
    authAudit.log("setup_complete", { admin: sys.adminUsername });

    // 2. 建第一个部门目录（如果有填）
    let createdDept = null;
    if (dept_name) {
      const trimmedName = dept_name.trim();
      const trimmedSheetId = (spreadsheet_id || "").trim();
      const trimmedTab = (sheet_tab || "").trim() || `关键词命中-${trimmedName}`;
      createdDept = await createDept({
        name: trimmedName,
        display: (dept_display || dept_name).trim(),
        outputChat: (output_chat || "").trim(),
        spreadsheetId: trimmedSheetId,
        sheetTab: trimmedTab,
        tgApiId: sys.tgApiId,
        tgApiHash: sys.tgApiHash,
      });
      // 自动建 Sheet 2 个分页 + 套模板 (跟 /depts/new 保持一致)
      if (trimmedSheetId) {
        try {
          await sheetTemplate.ensureTemplate({ spreadsheetId: trimmedSheetId, sheetName: trimmedTab, type: "keyword", dept: trimmedName, onlyIfMissing: true });
          await sheetTemplate.ensureTemplate({ spreadsheetId: trimmedSheetId, sheetName: `群名变更-${trimmedName}`, type: "title", dept: trimmedName, onlyIfMissing: true });
        } catch (e) { console.warn("[setup auto-template]", e.message); }
      }
    }

    // 3. 重生 ecosystem.config.js
    await regenerateEcosystem();

    // 4. 自动登入 (setup 就是在给自己开账号, 不用再跳 /login)
    auth.setAuthCookie(res, sys.adminUsername);

    res.redirect("/dashboard?setup=done" + (createdDept ? `&dept=${createdDept.name}` : ""));
  } catch (e) {
    console.error("setup failed:", e);
    renderSetup(res, { error: e.message, formData }, 400);
  }
});

// 重设 setup (开发用) — POST /dev/reset-setup
app.post("/dev/reset-setup", (_req, res) => {
  try {
    if (fs.existsSync(SYSTEM_JSON)) fs.unlinkSync(SYSTEM_JSON);
  } catch {}
  res.redirect("/setup");
});

// ─── Dashboard ───────────────────────────────────────
app.get("/dashboard", async (_req, res) => {
  // 一次性拉 depts + procs + alerts, 避免 getSystemSummary 内再跑一次 listProcesses
  // (pm2.connect 并发会 race, 一次成功一次超时 → 数据不一致)
  const [depts, procs, alerts] = await Promise.all([
    dataProvider.listDepartments(),
    dataProvider.listProcesses(),
    dataProvider.listAlerts(),
  ]);
  // 从已拉到的 procs/depts 计算 summary, 不再二次查 pm2
  const summary = {
    version: VERSION,
    mode: dataProvider.MODE,
    deptCount: depts.length,
    procTotal: procs.length,
    procOnline: procs.filter(p => p.status === "online").length,
    procOffline: procs.filter(p => p.status !== "online").length,
    totalHit24h: depts.reduce((a, d) => a + (d.hit24h || 0), 0),
    sessionBroken: depts.filter(d => !d.sessionOk).length,
  };
  // 顶部健康摘要卡
  const globalKinds = GLOBAL_KINDS;
  const globalProcsOnline = procs.filter(p => globalKinds.some(k => p.name === `tg-${k}`) && p.status === "online").length;
  const globalsBuilt = listGlobals().length;
  const deptProcsOnline = procs.filter(p => p.dept && p.dept !== "_global" && p.status === "online").length;
  const deptProcsTotal = depts.length * 1; // v0.4: 每部门 1 个 worker
  const healthcheck = readHealthcheckStatus();
  const backupList = updateManager.listBackups();
  const lastBackup = backupList[0] || null;
  const lastBackupAgo = lastBackup ? Math.floor((Date.now() - new Date(lastBackup.mtime).getTime()) / 86400000) : null;
  const gsaExists = fs.existsSync(GOOGLE_SA_PATH);

  const healthSummary = {
    depts: { total: depts.length, online: deptProcsOnline, totalProcs: deptProcsTotal, sessionBroken: depts.filter(d => !d.sessionOk).length },
    globals: { total: globalKinds.length, built: globalsBuilt, online: globalProcsOnline },
    healthcheck: healthcheck.enabled,
    backup: { count: backupList.length, lastAgo: lastBackupAgo, lastTs: lastBackup ? lastBackup.ts : null },
    gsa: gsaExists,
  };

  res.render("pages/dashboard", {
    title: "总览",
    active: "dashboard",
    summary,
    depts,
    procs,
    alerts,
    healthSummary,
  });
});

// ─── 部门列表 ───────────────────────────────────────
app.get("/depts", async (_req, res) => {
  const [depts, procs] = await Promise.all([
    dataProvider.listDepartments(),
    dataProvider.listProcesses(),
  ]);
  res.render("pages/depts", {
    title: "部门管理",
    active: "depts",
    depts,
    procs,
  });
});

// ─── 占位页 (D5 / v0.3 才实作) ──────────────────────
function placeholder(title, subtitle, stage, description) {
  return (_req, res) => {
    res.render("pages/placeholder", {
      title,
      subtitle,
      stage,
      description,
      active: "",
    });
  };
}

// ─── 新增部门（GET 表单 + POST 建目录）────────────────
function renderDeptNew(res, { error = null, formData = {}, templateFrom = null } = {}, status = 200) {
  res.status(status).render("pages/dept-new", {
    title: "新增部门",
    active: "depts",
    error,
    formData,
    templateFrom,
  });
}

app.get("/depts/new", (req, res) => {
  // ?template=<existing-dept-name> → 从该部门复制 config 作起始值 (不复制 dept_name)
  let formData = {};
  let templateFrom = null;
  if (req.query.template) {
    const src = loadDeptForEdit(String(req.query.template));
    if (src) {
      templateFrom = src.name;
      formData = {
        dept_display: src.config.display || src.name,
        output_chat: src.config.outputChatName || "",
        spreadsheet_id: src.config.spreadsheetId || "",
        sheet_tab: src.config.sheetName || "",
      };
    }
  }
  renderDeptNew(res, { formData, templateFrom });
});

app.post("/depts/new", async (req, res) => {
  const { dept_name, dept_display, output_chat, spreadsheet_id, sheet_tab } = req.body;
  const formData = { dept_name, dept_display, output_chat, spreadsheet_id, sheet_tab };
  try {
    const sys = fs.existsSync(SYSTEM_JSON)
      ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8"))
      : {};
    const trimmedName = (dept_name || "").trim();
    const trimmedSheetId = (spreadsheet_id || "").trim();
    const trimmedTab = (sheet_tab || "").trim() || `关键词命中-${trimmedName}`;
    const result = await createDept({
      name: trimmedName,
      display: (dept_display || dept_name || "").trim(),
      outputChat: (output_chat || "").trim(),
      spreadsheetId: trimmedSheetId,
      sheetTab: trimmedTab,
      tgApiId: sys.tgApiId,
      tgApiHash: sys.tgApiHash,
    });
    await regenerateEcosystem();
    // 自动建两个 Sheet 分页 + 模板 (keyword + title)
    let tplMsg = "";
    if (trimmedSheetId) {
      try {
        await sheetTemplate.ensureTemplate({ spreadsheetId: trimmedSheetId, sheetName: trimmedTab, type: "keyword", dept: trimmedName, onlyIfMissing: true });
        await sheetTemplate.ensureTemplate({ spreadsheetId: trimmedSheetId, sheetName: `群名变更-${trimmedName}`, type: "title", dept: trimmedName, onlyIfMissing: true });
        tplMsg = "&tpl=1";
      } catch (e) { console.warn("[new-dept auto-template]", e.message); tplMsg = "&tplerr=" + encodeURIComponent(e.message); }
    }
    res.redirect(`/depts?created=${result.name}${tplMsg}`);
  } catch (e) {
    console.error("create dept failed:", e);
    renderDeptNew(res, { error: e.message, formData }, 400);
  }
});
// ─── 编辑部门 ─────────────────────────────────
function loadDeptForEdit(name) {
  const { DEPTS_DIR: DD } = require("../scripts/new-dept");
  const deptDir = path.join(DD, name);
  if (!fs.existsSync(deptDir) || !fs.statSync(deptDir).isDirectory()) return null;
  const configPath = path.join(deptDir, "config.json");
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const sessionPath = path.join(deptDir, "session.txt");
  const sessionOk = fs.existsSync(sessionPath) && fs.statSync(sessionPath).size > 0;
  return {
    name,
    config,
    sessionOk,
    display: config.display || name,
  };
}

async function listProcsForDept(name) {
  const all = await dataProvider.listProcesses();
  return all.filter(p => p.dept === name);
}

app.get("/depts/:name/edit", async (req, res) => {
  const name = req.params.name;
  const dept = loadDeptForEdit(name);
  if (!dept) {
    return res.status(404).render("pages/placeholder", {
      title: "部门不存在", subtitle: "", stage: "",
      description: `depts/${name}/ 不存在.`, active: "depts",
    });
  }
  const procs = await listProcsForDept(name);
  res.render("pages/dept-edit", {
    title: `编辑 · ${name}`, active: "depts",
    dept, config: dept.config, procs,
    formData: {}, error: null, flash: req.query.flash || null,
  });
});

app.post("/depts/:name/edit", async (req, res) => {
  const name = req.params.name;
  const dept = loadDeptForEdit(name);
  if (!dept) return res.status(404).send("部门不存在");

  const body = req.body;
  // keywords: 支持 , ， 、 或换行 (向前兼容旧格式)
  const keywords = String(body.keywords || "")
    .split(/[,，、\n\r]+/)
    .map(s => s.trim())
    .filter(Boolean);

  // 时间字段: UI 输入友好单位 (分钟/秒), 后端转换成 ms 存
  // cooldownMinutes → cooldownMs
  let cooldownMs = dept.config.cooldownMs;
  if (body.cooldownMinutes !== undefined && body.cooldownMinutes !== "") {
    const m = Number(body.cooldownMinutes);
    if (Number.isFinite(m) && m >= 0) cooldownMs = Math.round(m * 60000);
  }
  // backfillIntervalSec → backfillIntervalMs
  let backfillIntervalMs = dept.config.backfillIntervalMs;
  if (body.backfillIntervalSec !== undefined && body.backfillIntervalSec !== "") {
    const s = Number(body.backfillIntervalSec);
    if (Number.isFinite(s) && s >= 10) backfillIntervalMs = Math.round(s * 1000);
  }

  try {
    const updated = {
      ...dept.config,
      display: body.display || dept.config.display,
      outputChatName: body.outputChatName,
      inputChatName: body.outputChatName, // 同步
      spreadsheetId: body.spreadsheetId,
      sheetName: body.sheetName,
      keywords,
      cooldownMs,
      summaryMaxLength: Number(body.summaryMaxLength) || dept.config.summaryMaxLength,
      backfillIntervalMs,
      backfillLimit: Number(body.backfillLimit) || dept.config.backfillLimit,
    };
    // titleSheet 可选: 同 Spreadsheet, 不同 tab. 填了就写, 没填就只推中转群不写表
    const titleTab = String(body.titleSheetName || "").trim();
    if (titleTab) {
      updated.titleSheet = { spreadsheetId: body.spreadsheetId, sheetName: titleTab };
    } else {
      delete updated.titleSheet;
    }
    const { DEPTS_DIR: DD } = require("../scripts/new-dept");
    fs.writeFileSync(
      path.join(DD, name, "config.json"),
      JSON.stringify(updated, null, 2) + "\n"
    );
    // 自动应用 Sheet 模板 (只对没模板的分页, 已有的不动)
    let templateFlash = "";
    if (updated.spreadsheetId && updated.sheetName) {
      try {
        const r = await sheetTemplate.ensureTemplate({
          spreadsheetId: updated.spreadsheetId,
          sheetName: updated.sheetName,
          type: "keyword",
          dept: name,
          onlyIfMissing: true,
        });
        if (!r.skipped) templateFlash = " · 已自动建关键字 Sheet 模板";
      } catch (e) { console.warn("[auto-template keyword]", e.message); }
    }
    // titleSheet 自动建模板
    if (updated.titleSheet && updated.titleSheet.spreadsheetId && updated.titleSheet.sheetName) {
      try {
        const r = await sheetTemplate.ensureTemplate({
          spreadsheetId: updated.titleSheet.spreadsheetId,
          sheetName: updated.titleSheet.sheetName,
          type: "title",
          dept: name,
          onlyIfMissing: true,
        });
        if (!r.skipped) templateFlash += " · 已自动建群名变更 Sheet 模板";
      } catch (e) { console.warn("[auto-template title]", e.message); }
    }
    // 保存后自动重启 (若进程在跑)
    await restartDept(name);
    res.redirect(`/depts/${name}/edit?flash=${encodeURIComponent("已保存 config.json 并尝试重启进程" + templateFlash)}`);
  } catch (e) {
    console.error("save config failed:", e);
    const procs = await listProcsForDept(name);
    res.status(400).render("pages/dept-edit", {
      title: `编辑 · ${name}`, active: "depts",
      dept, config: dept.config, procs,
      formData: body, error: e.message, flash: null,
    });
  }
});

// ─── PM2 控制 ────────────────────────────────
function pm2Exec(action, nameGlob) {
  return new Promise((resolve) => {
    // pm2 支援 name 模糊匹配，用 `tg-*-<dept>` 一次管 3 个
    execFile("pm2", [action, nameGlob], { cwd: ROOT }, (err, stdout, stderr) => {
      if (err) console.error(`[pm2 ${action} ${nameGlob}]`, stderr || err.message);
      else console.log(`[pm2 ${action} ${nameGlob}]`, stdout.trim().split("\n").slice(-3).join(" | "));
      resolve({ ok: !err, stdout, stderr: stderr || (err && err.message) || "" });
    });
  });
}

async function restartDept(name) {
  // 用 glob 同时管 3 类进程
  return pm2Exec("restart", `tg-*-${name}`);
}
async function startDept(name) {
  // 先 try start (若已跑会错 but 无害), fallback start ecosystem --only
  const ecosystemPath = path.join(ROOT, "ecosystem.config.js");
  if (!fs.existsSync(ecosystemPath)) {
    return { ok: false, stderr: "ecosystem.config.js 不存在, 请先新增部门后再启动" };
  }
  return new Promise((resolve) => {
    execFile("pm2", ["start", ecosystemPath, "--only", `tg-listener-${name},tg-system-events-${name},tg-sheet-writer-${name}`],
      { cwd: ROOT },
      (err, stdout, stderr) => {
        if (err) console.error(`[pm2 start ${name}]`, stderr || err.message);
        resolve({ ok: !err, stdout, stderr: stderr || (err && err.message) || "" });
      });
  });
}
async function stopDept(name) {
  return pm2Exec("stop", `tg-*-${name}`);
}

app.post("/depts/:name/restart", async (req, res) => {
  const { name } = req.params;
  await restartDept(name);
  res.redirect(`/depts/${name}/edit?flash=${encodeURIComponent("已触发 pm2 restart")}`);
});
app.post("/depts/:name/start", async (req, res) => {
  const { name } = req.params;
  await startDept(name);
  res.redirect(`/depts/${name}/edit?flash=${encodeURIComponent("已触发 pm2 start")}`);
});
app.post("/depts/:name/stop", async (req, res) => {
  const { name } = req.params;
  await stopDept(name);
  res.redirect(`/depts/${name}/edit?flash=${encodeURIComponent("已触发 pm2 stop")}`);
});

// ─── 删部门 ──────────────────────────────────
app.post("/depts/:name/delete", async (req, res) => {
  const { name } = req.params;
  const v = validateDeptName(name);
  if (!v.ok) return res.status(400).send(v.reason);
  try {
    const { DEPTS_DIR: DD } = require("../scripts/new-dept");
    const src = path.join(DD, name);
    if (!fs.existsSync(src)) return res.status(404).send("部门不存在");
    // 先停 PM2
    await pm2Exec("delete", `tg-*-${name}`);
    // 搬到 .trash
    const trashDir = path.join(DD, `.trash-${Date.now()}-${name}`);
    fs.renameSync(src, trashDir);
    // 重生 ecosystem
    await regenerateEcosystem();
    console.log(`[delete] ${name} → ${trashDir}`);
    res.redirect(`/depts?deleted=${name}`);
  } catch (e) {
    console.error("delete dept failed:", e);
    res.status(500).send(`删除失败: ${e.message}`);
  }
});

// ─── TG 登入 wizard (dept + global 都走这条) ─────────
const tgLogin = require("./lib/tg-login");

function renderLoginPage(res, target, extraCtx, opts = {}, status = 200) {
  // step=phone 时列出其他已登入的 session 可供复制
  const availableSessions = (opts.step === "phone" || !opts.step)
    ? tgLogin.listAvailableSessions(target)
    : [];
  res.status(status).render("pages/tg-login", {
    title: `TG 登入 · ${target.name}`,
    active: target.type === "dept" ? "depts" : "settings",
    target,                               // { type, name, ... }
    returnUrl: target.type === "dept" ? `/depts/${target.name}/edit` : `/settings`,
    postBase:  target.type === "dept" ? `/depts/${target.name}/login` : `/settings/global/${target.name}/login`,
    step: opts.step || "phone",
    phone: opts.phone || null,
    error: opts.error || null,
    bytes: opts.bytes || null,
    copied: opts.copied || null,
    availableSessions,
    ...extraCtx,
  });
}

// 登入成功后自动启动对应 worker (省用户手动点"启动")
async function autoStartAfterLogin(target) {
  try {
    const ecoPath = path.join(ROOT, "ecosystem.config.js");
    if (!fs.existsSync(ecoPath)) return;
    const onlyName = target.type === "dept" ? `tg-worker-${target.name}` : `tg-${target.name}`;
    await new Promise(r => execFile("pm2", ["start", ecoPath, "--only", onlyName], { cwd: ROOT }, (err, _o, stderr) => {
      if (err) console.warn(`[auto-start] pm2 start ${onlyName} 失败:`, stderr);
      else console.log(`[auto-start] ✓ pm2 start ${onlyName}`);
      r();
    }));
  } catch (e) { console.warn("[auto-start]", e.message); }
}

function handleLoginFlow(target, extraCtx) {
  return {
    get: (req, res) => {
      const s = tgLogin.getStatus(target);
      if (s.status === "awaiting_code")     return renderLoginPage(res, target, extraCtx, { step: "code",     phone: s.phone });
      if (s.status === "awaiting_password") return renderLoginPage(res, target, extraCtx, { step: "password", phone: s.phone });
      renderLoginPage(res, target, extraCtx, { step: "phone" });
    },
    phone: async (req, res) => {
      const phone = String(req.body.phone || "").trim();
      try {
        await tgLogin.startLogin(target, phone);
        renderLoginPage(res, target, extraCtx, { step: "code", phone });
      } catch (e) {
        console.error("[tg-login/phone]", target.key, e.message);
        renderLoginPage(res, target, extraCtx, { step: "phone", phone, error: e.message }, 400);
      }
    },
    code: async (req, res) => {
      const code = String(req.body.code || "").trim();
      try {
        const r = await tgLogin.submitCode(target, code);
        if (r.status === "done") {
          await autoStartAfterLogin(target);
          return renderLoginPage(res, target, extraCtx, { step: "done", bytes: r.bytes });
        }
        renderLoginPage(res, target, extraCtx, { step: "password" });
      } catch (e) {
        console.error("[tg-login/code]", target.key, e.message);
        const s = tgLogin.getStatus(target);
        const step = s.status === "awaiting_password" ? "password" : "code";
        renderLoginPage(res, target, extraCtx, { step, phone: s.phone, error: e.message }, 400);
      }
    },
    password: async (req, res) => {
      const password = String(req.body.password || "");
      try {
        const r = await tgLogin.submitPassword(target, password);
        await autoStartAfterLogin(target);
        renderLoginPage(res, target, extraCtx, { step: "done", bytes: r.bytes });
      } catch (e) {
        console.error("[tg-login/password]", target.key, e.message);
        renderLoginPage(res, target, extraCtx, { step: "password", error: e.message }, 400);
      }
    },
    abort: (req, res) => {
      tgLogin.abort(target);
      res.redirect(req.body._returnTo || "/");
    },
    copy: (req, res) => {
      try {
        const r = tgLogin.copySessionFrom(target, req.body.source_key);
        renderLoginPage(res, target, extraCtx, { step: "done", bytes: r.bytes, copied: r.source });
      } catch (e) {
        console.error("[tg-login/copy]", target.key, e.message);
        renderLoginPage(res, target, extraCtx, { step: "phone", error: `复制失败: ${e.message}` }, 400);
      }
    },
  };
}

// ─── Dept login ────────────────────────────────
app.get ("/depts/:name/login",          (req, res) => {
  const dept = loadDeptForEdit(req.params.name);
  if (!dept) return res.status(404).send(`部门不存在: ${req.params.name}`);
  const target = tgLogin.makeTarget("dept", req.params.name);
  handleLoginFlow(target, { outputChat: dept.config.outputChatName || "", subLabel: `部门 · ${req.params.name}` }).get(req, res);
});
app.post("/depts/:name/login/phone",    (req, res) => {
  const dept = loadDeptForEdit(req.params.name);
  if (!dept) return res.status(404).send("部门不存在");
  const target = tgLogin.makeTarget("dept", req.params.name);
  handleLoginFlow(target, { outputChat: dept.config.outputChatName || "", subLabel: `部门 · ${req.params.name}` }).phone(req, res);
});
app.post("/depts/:name/login/code",     (req, res) => {
  const dept = loadDeptForEdit(req.params.name);
  if (!dept) return res.status(404).send("部门不存在");
  const target = tgLogin.makeTarget("dept", req.params.name);
  handleLoginFlow(target, { outputChat: dept.config.outputChatName || "", subLabel: `部门 · ${req.params.name}` }).code(req, res);
});
app.post("/depts/:name/login/password", (req, res) => {
  const dept = loadDeptForEdit(req.params.name);
  if (!dept) return res.status(404).send("部门不存在");
  const target = tgLogin.makeTarget("dept", req.params.name);
  handleLoginFlow(target, { outputChat: dept.config.outputChatName || "", subLabel: `部门 · ${req.params.name}` }).password(req, res);
});
app.post("/depts/:name/login/abort",    (req, res) => {
  const target = tgLogin.makeTarget("dept", req.params.name);
  req.body._returnTo = `/depts/${req.params.name}/login`;
  handleLoginFlow(target, {}).abort(req, res);
});
app.post("/depts/:name/login/copy",     (req, res) => {
  const dept = loadDeptForEdit(req.params.name);
  if (!dept) return res.status(404).send("部门不存在");
  const target = tgLogin.makeTarget("dept", req.params.name);
  handleLoginFlow(target, { outputChat: dept.config.outputChatName || "", subLabel: `部门 · ${req.params.name}` }).copy(req, res);
});
app.get("/depts/:name",       (req, res) => res.redirect(`/depts/${req.params.name}/edit`));
app.get("/logs",                 placeholder("日志", "即时 pm2 logs 串流", "v0.3 实作", "留到 v0.3。届时可用 WebSocket 串 pm2 logs，按部门筛选 + 搜寻关键字。"));
app.get("/logs/:name",           placeholder("部门日志", "单部门 pm2 logs", "v0.3 实作", "留到 v0.3。"));
// ─── /settings (只留系统级: TG API / Google SA / 版本) ───
const CRON_MARKER = "# tg-monitor-multi healthcheck";

function readHealthcheckStatus() {
  // v0.4.2: 改读 system.json 的 healthcheckEnabled (Web 内置 setInterval, 不再用 crontab)
  let enabled = false;
  try {
    const sys = JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8"));
    enabled = Boolean(sys.healthcheckEnabled);
  } catch {}
  let logTail = "";
  const logPath = path.join(ROOT, ".healthcheck", "healthcheck.log");
  if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, "utf8").trim();
    logTail = content.split("\n").slice(-5).join("\n");
  }
  return {
    enabled,
    cronLine: enabled ? "Web 内置 5 分钟定时器 (Docker 友好)" : "",
    logTail,
  };
}

function readBackupsSummary() {
  const backupsDir = path.join(ROOT, ".backups");
  if (!fs.existsSync(backupsDir)) return { count: 0, totalSize: "0B" };
  const entries = fs.readdirSync(backupsDir).filter(n => {
    const p = path.join(backupsDir, n);
    return fs.statSync(p).isDirectory();
  });
  try {
    const { execSync } = require("child_process");
    const size = execSync(`du -sh "${backupsDir}" 2>/dev/null | cut -f1`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return { count: entries.length, totalSize: size || "?" };
  } catch {
    return { count: entries.length, totalSize: "?" };
  }
}

async function loadGlobalsForSettings() {
  const names = listGlobals();
  return names.map(kind => {
    const dir = path.join(ROOT, "global", kind);
    const sessionPath = path.join(dir, "session.txt");
    const sessionOk = fs.existsSync(sessionPath) && fs.statSync(sessionPath).size > 0;
    return { kind, dir, sessionOk };
  });
}

async function listAllProcesses() {
  return await dataProvider.listProcesses();
}

app.get("/settings", async (req, res) => {
  const sys = fs.existsSync(SYSTEM_JSON) ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")) : {};
  const gsaExists = fs.existsSync(GOOGLE_SA_PATH);
  let gsaEmail = "";
  if (gsaExists) {
    try { gsaEmail = JSON.parse(fs.readFileSync(GOOGLE_SA_PATH, "utf8")).client_email || ""; } catch {}
  }
  res.render("pages/settings", {
    title: "系统设置",
    active: "settings",
    systemInfo: {
      version: VERSION,
      mode: dataProvider.MODE,
      root: ROOT,
      nodeVersion: process.version,
      gsaExists,
      gsaEmail,
      tgApiId: sys.tgApiId || "",
      tgApiHash: sys.tgApiHash || "",
      metricsToken: sys.metricsToken || ensureMetricsToken(),
      publicDomain: (fs.existsSync(path.join(ROOT, ".env")) && (() => {
        try {
          const m = fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^PUBLIC_DOMAIN=(.+)$/m);
          return m ? m[1].trim() : "";
        } catch { return ""; }
      })()) || "",
    },
    flash: req.query.flash || null,
    error: req.query.error || null,
  });
});

// ─── 建立全局进程 ───────────────────────────────
app.post("/settings/global/new", async (req, res) => {
  const { kind } = req.body;
  try {
    const sys = fs.existsSync(SYSTEM_JSON) ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")) : {};
    const result = await createGlobal(kind, { tgApiId: sys.tgApiId, tgApiHash: sys.tgApiHash });
    await regenerateEcosystem();
    res.redirect(`/settings?flash=${encodeURIComponent(`已建立 global/${result.kind}/. 下一步: 点「编辑」填 config, 再点「🔑」走 TG 登入`)}`);
  } catch (e) {
    console.error("[settings/global/new]", e.message);
    res.redirect(`/settings?error=${encodeURIComponent(e.message)}`);
  }
});

// ─── 删除全局进程 (搬到 .trash) ─────────────────
app.post("/settings/global/:kind/delete", async (req, res) => {
  const { kind } = req.params;
  if (!GLOBAL_KINDS.includes(kind)) {
    return res.redirect(`/settings?error=${encodeURIComponent("unknown kind")}`);
  }
  try {
    // 1. 先彻底 pm2 delete (不是 stop, delete = 从 pm2 列表摘掉, 不再重启)
    await new Promise(r => execFile("pm2", ["delete", `tg-${kind}`], { cwd: ROOT }, () => r()));
    // 2. 目录搬到 .trash
    const src = path.join(ROOT, "global", kind);
    if (fs.existsSync(src)) {
      const trash = path.join(ROOT, "global", `.trash-${Date.now()}-${kind}`);
      fs.renameSync(src, trash);
      console.log(`[delete global] ${kind} → ${trash}`);
    }
    // 3. 重生 ecosystem (ecosystem.config.js 就不会再含它)
    await regenerateEcosystem();
    res.redirect(`/settings?flash=${encodeURIComponent(`已删除 tg-${kind} (目录搬到 global/.trash-*-${kind})`)}`);
  } catch (e) {
    res.redirect(`/settings?error=${encodeURIComponent(e.message)}`);
  }
});

// ─── 全局进程 PM2 控制 ───────────────────────────
app.post("/settings/global/:kind/:action", async (req, res) => {
  const { kind, action } = req.params;
  if (!GLOBAL_KINDS.includes(kind)) {
    return res.redirect(`/settings?error=${encodeURIComponent("unknown kind")}`);
  }
  if (!["restart", "start", "stop"].includes(action)) {
    return res.redirect(`/settings?error=${encodeURIComponent("unknown action")}`);
  }
  const procName = `tg-${kind}`;
  try {
    if (action === "start") {
      const ecoPath = path.join(ROOT, "ecosystem.config.js");
      if (!fs.existsSync(ecoPath)) throw new Error("ecosystem.config.js 不存在, 先建立全局进程");
      await new Promise(r => execFile("pm2", ["start", ecoPath, "--only", procName], { cwd: ROOT }, (err, _o, _e) => r()));
    } else {
      await pm2Exec(action, procName);
    }
    res.redirect(`/settings?flash=${encodeURIComponent(`已触发 pm2 ${action} ${procName}`)}`);
  } catch (e) {
    res.redirect(`/settings?error=${encodeURIComponent(e.message)}`);
  }
});

// ─── 全局进程: 编辑 config ─────────────────────
const GLOBAL_DIR = path.join(ROOT, "global");

function loadGlobalForEdit(kind) {
  if (!GLOBAL_KINDS.includes(kind)) return null;
  const dir = path.join(GLOBAL_DIR, kind);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const configPath = path.join(dir, "config.json");
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const sessionPath = path.join(dir, "session.txt");
  const sessionOk = fs.existsSync(sessionPath) && fs.statSync(sessionPath).size > 0;
  return { kind, dir, config, sessionOk };
}

app.get("/settings/global/:kind/edit", async (req, res) => {
  const kind = req.params.kind;
  const g = loadGlobalForEdit(kind);
  if (!g) {
    return res.status(404).render("pages/placeholder", {
      title: "未建立", subtitle: "", stage: "",
      description: `global/${kind}/ 不存在. 请先到 /settings 建立.`, active: "settings",
    });
  }
  const all = await dataProvider.listProcesses();
  const p = all.find(x => x.name === `tg-${kind}`);
  res.render("pages/global-edit", {
    title: `编辑 · ${kind}`, active: "settings",
    kind, g, proc: p, config: g.config,
    formData: {}, error: null, flash: req.query.flash || null,
  });
});

app.post("/settings/global/:kind/edit", async (req, res) => {
  const kind = req.params.kind;
  const g = loadGlobalForEdit(kind);
  if (!g) return res.status(404).send("未建立");
  const body = req.body;

  try {
    const updated = { ...g.config };
    if (body.backfillIntervalSec !== undefined && body.backfillIntervalSec !== "") {
      const s = Number(body.backfillIntervalSec);
      if (Number.isFinite(s) && s >= 10) updated.backfillIntervalMs = Math.round(s * 1000);
    }
    if (body.backfillLimit !== undefined && body.backfillLimit !== "") {
      const n = Number(body.backfillLimit);
      if (Number.isFinite(n) && n >= 1) updated.backfillLimit = n;
    }

    if (kind === "title-sheet-writer") {
      const routeKeys   = [].concat(body.route_key   || []);
      const routeInsts  = [].concat(body.route_inst  || []);
      const routeSheets = [].concat(body.route_sheet || []);
      const routeTabs   = [].concat(body.route_tab   || []);
      const routes = {};
      for (let i = 0; i < routeKeys.length; i++) {
        const k = String(routeKeys[i] || "").trim();
        if (!k) continue;
        routes[k] = {
          instance:      String(routeInsts[i]  || "").trim(),
          spreadsheetId: String(routeSheets[i] || "").trim(),
          sheetName:     String(routeTabs[i]   || "").trim(),
        };
      }
      updated.routes = routes;
    }

    if (kind === "review-report-writer") {
      updated.inputChatNames = String(body.input_chats || "")
        .split(/[,，、\n\r]+/).map(s => s.trim()).filter(Boolean);
      updated.spreadsheetId = String(body.spreadsheetId || "").trim();
      updated.sheetName     = String(body.sheetName     || "").trim();
      updated.keyword       = String(body.keyword       || "").trim() || "审查报告";
      updated.resultKeyword = String(body.resultKeyword || "").trim() || "闭环处理结果说明";
      updated.strictMode    = body.strictMode === "on" || body.strictMode === "true";
    }

    fs.writeFileSync(path.join(g.dir, "config.json"), JSON.stringify(updated, null, 2) + "\n");
    // review-report-writer 自动应用审查报告模板 (若分页没模板)
    let templateFlash = "";
    if (kind === "review-report-writer" && updated.spreadsheetId && updated.sheetName) {
      try {
        const r = await sheetTemplate.ensureTemplate({
          spreadsheetId: updated.spreadsheetId,
          sheetName: updated.sheetName,
          type: "review",
          onlyIfMissing: true,
        });
        if (!r.skipped) templateFlash = " · 已自动建 Sheet 模板";
      } catch (e) { console.warn("[auto-template global]", e.message); }
    }
    await pm2Exec("restart", `tg-${kind}`);
    res.redirect(`/settings/global/${kind}/edit?flash=${encodeURIComponent("已保存 config 并尝试重启" + templateFlash)}`);
  } catch (e) {
    console.error("save global config:", e);
    const all = await dataProvider.listProcesses();
    const p = all.find(x => x.name === `tg-${kind}`);
    res.status(400).render("pages/global-edit", {
      title: `编辑 · ${kind}`, active: "settings",
      kind, g, proc: p, config: g.config,
      formData: body, error: e.message, flash: null,
    });
  }
});

// ─── 全局进程: TG 登入 ─────────────────────────
app.get ("/settings/global/:kind/login",          (req, res) => {
  const kind = req.params.kind;
  if (!loadGlobalForEdit(kind)) return res.status(404).send("未建立");
  const target = tgLogin.makeTarget("global", kind);
  handleLoginFlow(target, { subLabel: `全局进程 · ${kind}` }).get(req, res);
});
app.post("/settings/global/:kind/login/phone",    (req, res) => {
  const kind = req.params.kind;
  if (!loadGlobalForEdit(kind)) return res.status(404).send("未建立");
  const target = tgLogin.makeTarget("global", kind);
  handleLoginFlow(target, { subLabel: `全局进程 · ${kind}` }).phone(req, res);
});
app.post("/settings/global/:kind/login/code",     (req, res) => {
  const kind = req.params.kind;
  if (!loadGlobalForEdit(kind)) return res.status(404).send("未建立");
  const target = tgLogin.makeTarget("global", kind);
  handleLoginFlow(target, { subLabel: `全局进程 · ${kind}` }).code(req, res);
});
app.post("/settings/global/:kind/login/password", (req, res) => {
  const kind = req.params.kind;
  if (!loadGlobalForEdit(kind)) return res.status(404).send("未建立");
  const target = tgLogin.makeTarget("global", kind);
  handleLoginFlow(target, { subLabel: `全局进程 · ${kind}` }).password(req, res);
});
app.post("/settings/global/:kind/login/abort",    (req, res) => {
  const kind = req.params.kind;
  const target = tgLogin.makeTarget("global", kind);
  req.body._returnTo = `/settings/global/${kind}/login`;
  handleLoginFlow(target, {}).abort(req, res);
});
app.post("/settings/global/:kind/login/copy",     (req, res) => {
  const kind = req.params.kind;
  if (!loadGlobalForEdit(kind)) return res.status(404).send("未建立");
  const target = tgLogin.makeTarget("global", kind);
  handleLoginFlow(target, { subLabel: `全局进程 · ${kind}` }).copy(req, res);
});

// ─── 日志读取 API ─────────────────────────────
const logReader = require("./lib/log-reader");

const DEPT_KINDS = ["worker", "listener", "system-events", "sheet-writer"]; // worker=v0.4, 其余保留读旧 log
const ALLOWED_GLOBAL_KINDS = GLOBAL_KINDS; // 从 new-global.js 导入的

app.get("/api/logs/dept/:name/:kind", (req, res) => {
  const { name, kind } = req.params;
  if (!DEPT_KINDS.includes(kind)) return res.status(400).json({ error: "kind 不合法" });
  const type = req.query.type === "err" ? "err" : "out";
  const lines = Math.min(Number(req.query.lines) || 100, 500);
  const r = logReader.readTail({ scope: "dept", dept: name, kind, type, lines });
  res.json(r);
});

app.get("/api/logs/global/:kind", (req, res) => {
  const { kind } = req.params;
  if (!ALLOWED_GLOBAL_KINDS.includes(kind)) return res.status(400).json({ error: "kind 不合法" });
  const type = req.query.type === "err" ? "err" : "out";
  const lines = Math.min(Number(req.query.lines) || 100, 500);
  const r = logReader.readTail({ scope: "global", kind, type, lines });
  res.json(r);
});

// ─── TG 群列表 API ─────────────────────────────
const tgDialogs = require("./lib/tg-dialogs");

app.get("/api/tg-dialogs/dept/:name", async (req, res) => {
  try {
    const r = await tgDialogs.listDialogs("dept", req.params.name);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
app.get("/api/tg-dialogs/global/:kind", async (req, res) => {
  try {
    const r = await tgDialogs.listDialogs("global", req.params.kind);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── 连线测试 API ─────────────────────────────
const connectionTester = require("./lib/connection-tester");

app.post("/api/test/gsa", async (_req, res) => {
  res.json(await connectionTester.testGsa());
});
app.post("/api/test/sheet", async (req, res) => {
  const { spreadsheetId, sheetName } = req.body || {};
  res.json(await connectionTester.testSheetWrite({ spreadsheetId, sheetName }));
});
app.get("/api/sheet-tabs", async (req, res) => {
  res.json(await connectionTester.listSheetTabs({ spreadsheetId: req.query.spreadsheetId }));
});

// 初始化 Sheet 模板 (自动建分页 + 表头 + 斑马纹 + 冻结)
const sheetTemplate = require("./lib/sheet-template");
app.post("/api/sheet-template/init", async (req, res) => {
  const { spreadsheetId, sheetName, type, dept } = req.body || {};
  try {
    const r = await sheetTemplate.ensureTemplate({ spreadsheetId, sheetName, type, dept });
    res.json(r);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 模板管理已砍 — 用户想改样式自己去 Sheet 调, 预设表头写死
app.get("/settings/sheet-templates/_disabled", (req, res) => {
  const types = ["keyword", "title", "review"];
  const templates = types.map(t => {
    const base = sheetTemplate.TEMPLATES[t];
    const effective = sheetTemplate.getEffectiveTemplate(t, { dept: "<dept>" });
    const custom = sheetTemplate.loadCustom()[t] || {};
    return {
      type: t,
      label: { keyword: "关键字命中记录", title: "群名变更履历", review: "审查报告汇总表" }[t],
      defaultTitleTemplate: base.titleTemplate,
      currentTitleTemplate: effective.titleTemplate,
      currentTitle: effective.title,
      columns: effective.columns,
      defaultColumns: base.columns,
      availableFields: base.availableFields || {},
      readOnly: Boolean(base.readOnly),
      isCustomized: Boolean(custom.columns || custom.titleTemplate),
    };
  });
  res.render("pages/sheet-templates", {
    title: "Sheet 模板管理",
    active: "settings",
    templates,
    flash: req.query.flash || null,
    error: req.query.error || null,
  });
});

app.post("/settings/sheet-templates/:type", (req, res) => {
  const { type } = req.params;
  if (!sheetTemplate.TEMPLATES[type]) return res.redirect(`/settings/sheet-templates?error=${encodeURIComponent("未知类型")}`);
  if (sheetTemplate.TEMPLATES[type].readOnly) return res.redirect(`/settings/sheet-templates?error=${encodeURIComponent(`${type} 模板不可修改 (baseline 耦合)`)}`);
  try {
    const titleTemplate = (req.body.title_template || "").trim();
    // columns 用隐藏 JSON 字段提交 (UI 用 JS 维护)
    let columns = null;
    if (req.body.columns_json) {
      const parsed = JSON.parse(req.body.columns_json);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("列配置格式错或为空");
      columns = parsed.map(c => ({
        header: String(c.header || "").trim() || "(未命名)",
        field: String(c.field || "").trim(),
        width: Number(c.width) || 120,
        wrap: Boolean(c.wrap),
      }));
    }
    sheetTemplate.saveCustom(type, {
      titleTemplate: titleTemplate || null,
      columns: columns || null,
    });
    res.redirect(`/settings/sheet-templates?flash=${encodeURIComponent(`已保存 ${type} 模板 (${columns ? columns.length + ' 列' : '默认列'}). 下次应用/保存 config 时生效`)}`);
  } catch (e) {
    res.redirect(`/settings/sheet-templates?error=${encodeURIComponent(e.message)}`);
  }
});

app.post("/settings/sheet-templates/:type/reset", (req, res) => {
  const { type } = req.params;
  try {
    sheetTemplate.saveCustom(type, { titleTemplate: null, columns: null });
    res.redirect(`/settings/sheet-templates?flash=${encodeURIComponent(`${type} 已重置为默认`)}`);
  } catch (e) {
    res.redirect(`/settings/sheet-templates?error=${encodeURIComponent(e.message)}`);
  }
});

// ─── 升级 / 回滚 ─────────────────────────────
const updateManager = require("./lib/update-manager");

app.get("/api/updates/check", (_req, res) => {
  res.json(updateManager.checkUpdates());
});

function renderUpdateResult(res, title, result, error) {
  res.render("pages/update-result", {
    title,
    active: "settings",
    resultTitle: title,
    log: result ? result.log : "",
    error,
    backupTs: result ? result.backupTs : null,
  });
}

app.post("/settings/update", async (_req, res) => {
  try {
    const r = updateManager.softUpdate();
    renderUpdateResult(res, "升级结果", r, null);
  } catch (e) {
    renderUpdateResult(res, "升级失败", { log: e.message }, e.message);
  }
});

app.post("/settings/rollback/:ts", async (req, res) => {
  try {
    const r = updateManager.rollback(req.params.ts);
    renderUpdateResult(res, `回滚结果 · ${req.params.ts}`, r, null);
  } catch (e) {
    renderUpdateResult(res, `回滚失败 · ${req.params.ts}`, { log: e.message }, e.message);
  }
});

// ─── Healthcheck (内置 setInterval, Docker 友好) ─────
const internalHealthcheck = require("./lib/internal-healthcheck");

app.post("/settings/healthcheck/install", async (_req, res) => {
  try {
    internalHealthcheck.setEnabled(true);
    internalHealthcheck.start();
    res.redirect(`/settings?flash=${encodeURIComponent("Healthcheck 已启用 (Web 内置, 5 分钟扫一次)")}`);
  } catch (e) {
    res.redirect(`/settings?error=${encodeURIComponent(`启用失败: ${e.message}`)}`);
  }
});
app.post("/settings/healthcheck/remove", async (_req, res) => {
  try {
    internalHealthcheck.setEnabled(false);
    internalHealthcheck.stop();
    res.redirect(`/settings?flash=${encodeURIComponent("Healthcheck 已停用")}`);
  } catch (e) {
    res.redirect(`/settings?error=${encodeURIComponent(`停用失败: ${e.message}`)}`);
  }
});


// ─── 启动 ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("╔════════════════════════════════════════════════════════");
  console.log("║  tg-monitor-multi · v" + VERSION);
  console.log("║  mode:   " + dataProvider.MODE.toUpperCase());
  console.log("║  listen: http://localhost:" + PORT);
  console.log("║  root:   " + ROOT);
  if (process.env.TG_MONITOR_MULTI_DOCKER === "1") {
    console.log("║  env:    DOCKER (tg-* 进程由本 Web 的同 pm2 daemon 管)");
  }
  console.log("╚════════════════════════════════════════════════════════");

  // 启动时若 healthcheckEnabled=true, 自动启动内置健康检查定时器
  internalHealthcheck.bootstrap();

  // 启动时: 先重生 ecosystem (对齐 depts/ + global/ 的最新状态), 再 pm2 start
  // (让容器重启 / 代码升级后, 既有部门进程自动拉起, 且配置跟 depts/ 目录真实状态一致)
  const ecoPath = path.join(ROOT, "ecosystem.config.js");
  (async () => {
    try {
      const hasContent = fs.existsSync(path.join(ROOT, "depts")) &&
        fs.readdirSync(path.join(ROOT, "depts")).some(n => !n.startsWith("_") && !n.startsWith("."));
      const hasGlobal = fs.existsSync(path.join(ROOT, "global")) &&
        fs.readdirSync(path.join(ROOT, "global")).some(n => !n.startsWith("_") && !n.startsWith("."));
      if (hasContent || hasGlobal) {
        console.log("[boot] 重生 ecosystem.config.js 以对齐 depts/ + global/ 真实状态...");
        await regenerateEcosystem();
      }
    } catch (e) {
      console.warn("[boot] 启动期 ecosystem 重生失败:", e.message);
    }
    // 然后 pm2 start (若有定义)
    if (fs.existsSync(ecoPath)) {
      try {
        const content = fs.readFileSync(ecoPath, "utf8");
        if (content.includes('"name"')) {
          console.log("[boot] 侦测到 ecosystem.config.js 含进程定义, 尝试 pm2 start...");
          execFile("pm2", ["start", ecoPath], { cwd: ROOT }, (err, stdout, stderr) => {
            if (err) {
              console.warn("[boot] pm2 start ecosystem 失败:", (stderr || err.message).split("\n")[0]);
            } else {
              console.log("[boot] ecosystem 载入完成");
            }
          });
        }
      } catch (e) {
        console.warn("[boot] 读 ecosystem.config.js 失败:", e.message);
      }
    }
  })();
});
// ─── /review + /ops 放最后 (放前面会 ReferenceError 因为依赖在后面声明) ───

// ─── /ops — 运维页 (healthcheck + 升级 + 备份) ───────
app.get("/ops", async (req, res) => {
  const healthcheck = readHealthcheckStatus();
  const backupList = updateManager.listBackups().slice(0, 10);
  res.render("pages/ops", {
    title: "运维",
    active: "ops",
    healthcheck,
    backupList,
    flash: req.query.flash || null,
    error: req.query.error || null,
  });
});
app.post("/ops/healthcheck/install", (_req, res) => {
  try { internalHealthcheck.setEnabled(true); internalHealthcheck.start(); res.redirect("/ops?flash=" + encodeURIComponent("健康检查已启用 (5 分钟扫一次)")); }
  catch (e) { res.redirect("/ops?error=" + encodeURIComponent(e.message)); }
});
app.post("/ops/healthcheck/remove", (_req, res) => {
  try { internalHealthcheck.setEnabled(false); internalHealthcheck.stop(); res.redirect("/ops?flash=" + encodeURIComponent("健康检查已停用")); }
  catch (e) { res.redirect("/ops?error=" + encodeURIComponent(e.message)); }
});
app.post("/ops/update", async (_req, res) => {
  try { const r = updateManager.softUpdate(); renderUpdateResult(res, "升级结果", r, null); }
  catch (e) { renderUpdateResult(res, "升级失败", { log: e.message }, e.message); }
});
app.post("/ops/rollback/:ts", async (req, res) => {
  try { const r = updateManager.rollback(req.params.ts); renderUpdateResult(res, `回滚结果 · ${req.params.ts}`, r, null); }
  catch (e) { renderUpdateResult(res, `回滚失败 · ${req.params.ts}`, { log: e.message }, e.message); }
});


// ═════════════════════════════════════════════════════
// 外部 API — /api/v1/metrics
// 给中央看板 / 监控系统拉数据. Bearer token 鉴权.
// Schema 对齐姊妹项目 tg-monitor-template 的 snapshot().
// ═════════════════════════════════════════════════════
const crypto = require("crypto");
const dashboardSnapshot = require("./lib/dashboard-snapshot");
const METRICS_LOG = path.join(DATA_DIR, "metrics-access.jsonl");

function genMetricsToken() {
  return crypto.randomBytes(24).toString("base64url"); // 32 chars, url-safe
}

// 取 token, 没就生成 + 写回 system.json. 同时保证 data/ 存在.
function ensureMetricsToken() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const sys = fs.existsSync(SYSTEM_JSON) ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")) : {};
  if (!sys.metricsToken) {
    sys.metricsToken = genMetricsToken();
    fs.writeFileSync(SYSTEM_JSON, JSON.stringify(sys, null, 2));
  }
  return sys.metricsToken;
}

function logMetricsAccess(ok, reason, ip) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const entry = { ts: new Date().toISOString(), ip, ok, reason };
    fs.appendFileSync(METRICS_LOG, JSON.stringify(entry) + "\n");
    // 简单 rotate: >1MB 切一下, 保留最近 500 行
    const st = fs.statSync(METRICS_LOG);
    if (st.size > 1024 * 1024) {
      const lines = fs.readFileSync(METRICS_LOG, "utf8").trim().split("\n");
      fs.writeFileSync(METRICS_LOG, lines.slice(-500).join("\n") + "\n");
    }
  } catch { /* log 写失败不影响主流程 */ }
}

app.get("/api/v1/metrics", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim();
  const expected = ensureMetricsToken();

  // 从 Authorization: Bearer xxx 或 ?token= 取
  let provided = "";
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("bearer ")) provided = auth.slice(7).trim();
  else provided = String(req.query.token || "").trim();

  // 等长 + timingSafeEqual 防时序攻击
  let authorized = false;
  if (provided && provided.length === expected.length) {
    authorized = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  }
  if (!authorized) {
    logMetricsAccess(false, "unauthorized", ip);
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const data = await dashboardSnapshot.snapshot();
    logMetricsAccess(true, "ok", ip);
    res.json(data);
  } catch (e) {
    console.error("metrics snapshot failed:", e);
    logMetricsAccess(false, `snapshot_error: ${e.message}`, ip);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/v1/metrics/access_log", (_req, res) => {
  let entries = [];
  try {
    if (fs.existsSync(METRICS_LOG)) {
      entries = fs.readFileSync(METRICS_LOG, "utf8").trim().split("\n")
        .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
  } catch { /* 读失败就空 */ }
  const now = Date.now();
  const count24h = entries.filter(e => now - Date.parse(e.ts) < 86400000).length;
  const last = entries[entries.length - 1] || null;
  res.json({
    ok: true,
    count_24h: count24h,
    last_access: last ? last.ts : null,
    recent: entries.slice(-20).reverse(),
  });
});

app.post("/api/settings/metrics_token/regenerate", (_req, res) => {
  try {
    const sys = fs.existsSync(SYSTEM_JSON) ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")) : {};
    sys.metricsToken = genMetricsToken();
    fs.writeFileSync(SYSTEM_JSON, JSON.stringify(sys, null, 2));
    res.json({ ok: true, token: sys.metricsToken });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 首次启动时生成 token (下次 /setup 提交时会再次确保)
try { ensureMetricsToken(); } catch (e) { console.warn("metrics token init:", e.message); }


// ═════════════════════════════════════════════════════
// 管理员 TG bot 绑定 / 管理
// ═════════════════════════════════════════════════════

// 保存 bot token + 启 bot
app.post("/api/auth/bot_token", (req, res) => {
  const token = String((req.body && req.body.token) || "").trim();
  if (!token) {
    // 清掉 token
    try {
      const sys = fs.existsSync(SYSTEM_JSON) ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")) : {};
      delete sys.botToken;
      fs.writeFileSync(SYSTEM_JSON, JSON.stringify(sys, null, 2));
      adminBot.restart();
      authAudit.log("bot_token_clear", { ip: auth.clientIp(req), by: req.user?.username });
      return res.json({ ok: true, cleared: true });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  // 简单格式检查 (TG bot token 形如 123456789:ABC-DEF...)
  if (!/^\d{5,}:[\w-]{25,}$/.test(token)) {
    return res.json({ ok: false, error: "格式不像 TG bot token (应为 123456:ABCDEF...)" });
  }
  try {
    const sys = fs.existsSync(SYSTEM_JSON) ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")) : {};
    sys.botToken = token;
    fs.writeFileSync(SYSTEM_JSON, JSON.stringify(sys, null, 2));
    adminBot.restart();
    authAudit.log("bot_token_set", { ip: auth.clientIp(req), by: req.user?.username });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 查 bot 状态
app.get("/api/auth/bot_status", (_req, res) => {
  res.json({ ok: true, ...adminBot.status() });
});

// 生成绑定码
app.post("/api/auth/bind_start", (req, res) => {
  const sys = fs.existsSync(SYSTEM_JSON) ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")) : {};
  if (!sys.botToken) return res.json({ ok: false, error: "先在上面填 Bot Token 并启动 bot" });
  const code = adminReset.createBindPending();
  authAudit.log("bind_code_generated", { ip: auth.clientIp(req), by: req.user?.username });
  res.json({ ok: true, code, ttl_min: adminReset.BIND_TTL_MS / 60000 });
});

// 解绑
app.post("/api/auth/unbind", (req, res) => {
  adminReset.unbind();
  authAudit.log("tg_unbind", { ip: auth.clientIp(req), by: req.user?.username });
  res.json({ ok: true });
});

// audit log 查看 (最近 N 条)
app.get("/api/auth/audit_log", (req, res) => {
  const n = Math.min(200, Math.max(10, Number(req.query.n) || 50));
  res.json({ ok: true, entries: authAudit.read(n) });
});

// 改密码 (已登入, 需要旧密码)
app.post("/api/auth/change_password", (req, res) => {
  const { old_password = "", new_password = "" } = req.body || {};
  if (!old_password || !new_password) return res.json({ ok: false, error: "参数不完整" });
  if (String(new_password).length < 8) return res.json({ ok: false, error: "新密码至少 8 位" });
  const sys = fs.existsSync(SYSTEM_JSON) ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")) : {};
  const ok = auth.verifyPassword(old_password, sys.adminPasswordHash);
  if (!ok) {
    authAudit.log("change_pwd_fail", { ip: auth.clientIp(req), by: req.user?.username });
    return res.json({ ok: false, error: "旧密码错误" });
  }
  sys.adminPasswordHash = auth.hashPassword(new_password);
  delete sys.adminPassword;
  try { fs.writeFileSync(SYSTEM_JSON, JSON.stringify(sys, null, 2)); } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  authAudit.log("change_pwd_success", { ip: auth.clientIp(req), by: req.user?.username });
  res.json({ ok: true });
});

// 启动 bot (若已配 token)
try { adminBot.start(); } catch (e) { console.warn("admin-bot start:", e.message); }

// 启动 session 死亡 watcher (每 5 分钟扫部门, 新死的 DM 管理员)
try { sessionWatcher.start(); } catch (e) { console.warn("session-watcher start:", e.message); }


// ─── 404 (必须放最后, 让所有具体路由先匹配) ───────
app.use((_req, res) => {
  res.status(404).render("pages/placeholder", {
    title: "404", subtitle: "页面不存在", stage: "",
    description: "你访问的路径不存在。返回总览看看？", active: "",
  });
});
