// tg-monitor-multi — Web Dashboard
// v0.2.0-mvp 預覽版 (D3+D4 合併推進)
//
// 啟動：
//   cd web && npm install && npm start
//   瀏覽 http://localhost:5003
//
// 資料源：預設 mock，環境變數 DATA_PROVIDER=real 切到實際 pm2+depts/

const express = require("express");
const expressLayouts = require("express-ejs-layouts");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const dataProvider = require("./lib/data-provider");
const { createDept, validateDeptName } = require("../scripts/new-dept");
const { createGlobal, listGlobals, KINDS: GLOBAL_KINDS } = require("../scripts/new-global");

// multer: 處理 multipart/form-data (檔案上傳). 記憶體儲存, 200KB 上限 (Google SA JSON 通常 ~2KB)
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

// ─── 靜態 / body parser ──────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── 全域 locals ─────────────────────────────────────
app.use((_req, res, next) => {
  res.locals.version = VERSION;
  res.locals.mode = dataProvider.MODE;
  res.locals.active = "";
  res.locals.showNav = true;
  next();
});

// ─── 輔助: 呼叫 scripts/generate-ecosystem.js ────────
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

// ─── 根路徑 → 自動判斷去哪 ───────────────────────────
app.get("/", async (_req, res) => {
  const complete = await dataProvider.isSetupComplete();
  res.redirect(complete ? "/dashboard" : "/setup");
});

// ─── 健康檢查 API ────────────────────────────────────
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
  });
});

app.post("/login", (_req, res) => {
  // MVP 佔位：任何登入都成功 (v0.6 正式做 bcrypt 驗證)
  res.redirect("/dashboard");
});

app.get("/logout", (_req, res) => res.redirect("/login"));

// ─── Setup Wizard ────────────────────────────────────
function renderSetup(res, { error = null, formData = {} } = {}, status = 200) {
  const saExists = fs.existsSync(GOOGLE_SA_PATH);
  let saInfo = null;
  if (saExists) {
    try {
      const sa = JSON.parse(fs.readFileSync(GOOGLE_SA_PATH, "utf8"));
      saInfo = { clientEmail: sa.client_email || "(未知)", projectId: sa.project_id || "" };
    } catch { /* 解析失敗也顯示檔案存在但結構壞 */ }
  }
  res.status(status).render("pages/setup", {
    title: "首次設置",
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

// 處理 google_sa 檔案上傳 (單檔, field name = google_sa)
app.post("/setup", upload.single("google_sa"), async (req, res) => {
  // 第 1 批: 先驗證 → 通過才寫檔 + 建部門 + 重生 ecosystem
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
    // 0a. 若有填部門, 先驗 dept_name
    if (dept_name) {
      const v = validateDeptName(dept_name.trim());
      if (!v.ok) {
        return renderSetup(res, { error: `部門代號: ${v.reason}`, formData }, 400);
      }
    }

    // 0b. 若有上傳 Google SA 檔, 先驗 JSON 結構
    if (req.file && req.file.buffer) {
      let parsed;
      try {
        parsed = JSON.parse(req.file.buffer.toString("utf8"));
      } catch {
        return renderSetup(res, { error: "Google SA 檔案不是有效 JSON", formData }, 400);
      }
      if (!parsed.type || parsed.type !== "service_account" || !parsed.client_email || !parsed.private_key) {
        return renderSetup(res, {
          error: "Google SA 檔案結構不對: 缺少 type/client_email/private_key. 請從 GCP Console → IAM → Service Accounts 下載 JSON key.",
          formData,
        }, 400);
      }
      // 驗證通過, 寫到 shared/
      fs.writeFileSync(GOOGLE_SA_PATH, req.file.buffer.toString("utf8"));
      console.log(`[setup] Google SA 已保存: ${parsed.client_email}`);
    }

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // 1. 寫 system.json
    const sys = fs.existsSync(SYSTEM_JSON)
      ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8"))
      : {};
    Object.assign(sys, {
      setupComplete: true,
      setupAt: new Date().toISOString(),
      adminUsername: admin_username || "admin",
      adminPassword: admin_password || null,
      tgApiId: tg_api_id || sys.tgApiId || "",
      tgApiHash: tg_api_hash || sys.tgApiHash || "",
    });
    fs.writeFileSync(SYSTEM_JSON, JSON.stringify(sys, null, 2));

    // 2. 建第一個部門目錄（如果有填）
    let createdDept = null;
    if (dept_name) {
      createdDept = await createDept({
        name: dept_name.trim(),
        display: (dept_display || dept_name).trim(),
        outputChat: (output_chat || "").trim(),
        spreadsheetId: (spreadsheet_id || "").trim(),
        sheetTab: (sheet_tab || "").trim(),
        tgApiId: sys.tgApiId,
        tgApiHash: sys.tgApiHash,
      });
    }

    // 3. 重生 ecosystem.config.js
    await regenerateEcosystem();

    res.redirect("/dashboard?setup=done" + (createdDept ? `&dept=${createdDept.name}` : ""));
  } catch (e) {
    console.error("setup failed:", e);
    renderSetup(res, { error: e.message, formData }, 400);
  }
});

// 重設 setup (開發用) — POST /dev/reset-setup
app.post("/dev/reset-setup", (_req, res) => {
  try {
    if (fs.existsSync(SYSTEM_JSON)) fs.unlinkSync(SYSTEM_JSON);
  } catch {}
  res.redirect("/setup");
});

// ─── Dashboard ───────────────────────────────────────
app.get("/dashboard", async (_req, res) => {
  const [summary, depts, procs, alerts] = await Promise.all([
    dataProvider.getSystemSummary(),
    dataProvider.listDepartments(),
    dataProvider.listProcesses(),
    dataProvider.listAlerts(),
  ]);
  res.render("pages/dashboard", {
    title: "總覽",
    active: "dashboard",
    summary,
    depts,
    procs,
    alerts,
  });
});

// ─── 部門列表 ───────────────────────────────────────
app.get("/depts", async (_req, res) => {
  const [depts, procs] = await Promise.all([
    dataProvider.listDepartments(),
    dataProvider.listProcesses(),
  ]);
  res.render("pages/depts", {
    title: "部門管理",
    active: "depts",
    depts,
    procs,
  });
});

// ─── 佔位頁 (D5 / v0.3 才實作) ──────────────────────
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

// ─── 新增部門（GET 表單 + POST 建目錄）────────────────
function renderDeptNew(res, { error = null, formData = {} } = {}, status = 200) {
  res.status(status).render("pages/dept-new", {
    title: "新增部門",
    active: "depts",
    error,
    formData,
  });
}

app.get("/depts/new", (_req, res) => {
  renderDeptNew(res);
});

app.post("/depts/new", async (req, res) => {
  const { dept_name, dept_display, output_chat, spreadsheet_id, sheet_tab } = req.body;
  const formData = { dept_name, dept_display, output_chat, spreadsheet_id, sheet_tab };
  try {
    const sys = fs.existsSync(SYSTEM_JSON)
      ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8"))
      : {};
    const result = await createDept({
      name: (dept_name || "").trim(),
      display: (dept_display || dept_name || "").trim(),
      outputChat: (output_chat || "").trim(),
      spreadsheetId: (spreadsheet_id || "").trim(),
      sheetTab: (sheet_tab || "").trim(),
      tgApiId: sys.tgApiId,
      tgApiHash: sys.tgApiHash,
    });
    await regenerateEcosystem();
    res.redirect(`/depts?created=${result.name}`);
  } catch (e) {
    console.error("create dept failed:", e);
    renderDeptNew(res, { error: e.message, formData }, 400);
  }
});
// ─── 編輯部門 ─────────────────────────────────
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
      title: "部門不存在", subtitle: "", stage: "",
      description: `depts/${name}/ 不存在.`, active: "depts",
    });
  }
  const procs = await listProcsForDept(name);
  res.render("pages/dept-edit", {
    title: `編輯 · ${name}`, active: "depts",
    dept, config: dept.config, procs,
    formData: {}, error: null, flash: req.query.flash || null,
  });
});

app.post("/depts/:name/edit", async (req, res) => {
  const name = req.params.name;
  const dept = loadDeptForEdit(name);
  if (!dept) return res.status(404).send("部門不存在");

  const body = req.body;
  // keywords textarea → 陣列
  const keywords = String(body.keywords || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  try {
    const updated = {
      ...dept.config,
      display: body.display || dept.config.display,
      outputChatName: body.outputChatName,
      inputChatName: body.outputChatName, // 同步
      spreadsheetId: body.spreadsheetId,
      sheetName: body.sheetName,
      keywords,
      cooldownMs: Number(body.cooldownMs) || dept.config.cooldownMs,
      summaryMaxLength: Number(body.summaryMaxLength) || dept.config.summaryMaxLength,
      backfillIntervalMs: Number(body.backfillIntervalMs) || dept.config.backfillIntervalMs,
      backfillLimit: Number(body.backfillLimit) || dept.config.backfillLimit,
    };
    const { DEPTS_DIR: DD } = require("../scripts/new-dept");
    fs.writeFileSync(
      path.join(DD, name, "config.json"),
      JSON.stringify(updated, null, 2) + "\n"
    );
    // 保存後自動重啟 (若進程在跑)
    await restartDept(name);
    res.redirect(`/depts/${name}/edit?flash=${encodeURIComponent("已保存 config.json 並嘗試重啟進程")}`);
  } catch (e) {
    console.error("save config failed:", e);
    const procs = await listProcsForDept(name);
    res.status(400).render("pages/dept-edit", {
      title: `編輯 · ${name}`, active: "depts",
      dept, config: dept.config, procs,
      formData: body, error: e.message, flash: null,
    });
  }
});

// ─── PM2 控制 ────────────────────────────────
function pm2Exec(action, nameGlob) {
  return new Promise((resolve) => {
    // pm2 支援 name 模糊匹配，用 `tg-*-<dept>` 一次管 3 個
    execFile("pm2", [action, nameGlob], { cwd: ROOT }, (err, stdout, stderr) => {
      if (err) console.error(`[pm2 ${action} ${nameGlob}]`, stderr || err.message);
      else console.log(`[pm2 ${action} ${nameGlob}]`, stdout.trim().split("\n").slice(-3).join(" | "));
      resolve({ ok: !err, stdout, stderr: stderr || (err && err.message) || "" });
    });
  });
}

async function restartDept(name) {
  // 用 glob 同時管 3 類進程
  return pm2Exec("restart", `tg-*-${name}`);
}
async function startDept(name) {
  // 先 try start (若已跑會錯 but 無害), fallback start ecosystem --only
  const ecosystemPath = path.join(ROOT, "ecosystem.config.js");
  if (!fs.existsSync(ecosystemPath)) {
    return { ok: false, stderr: "ecosystem.config.js 不存在, 請先新增部門後再啟動" };
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
  res.redirect(`/depts/${name}/edit?flash=${encodeURIComponent("已觸發 pm2 restart")}`);
});
app.post("/depts/:name/start", async (req, res) => {
  const { name } = req.params;
  await startDept(name);
  res.redirect(`/depts/${name}/edit?flash=${encodeURIComponent("已觸發 pm2 start")}`);
});
app.post("/depts/:name/stop", async (req, res) => {
  const { name } = req.params;
  await stopDept(name);
  res.redirect(`/depts/${name}/edit?flash=${encodeURIComponent("已觸發 pm2 stop")}`);
});

// ─── 刪部門 ──────────────────────────────────
app.post("/depts/:name/delete", async (req, res) => {
  const { name } = req.params;
  const v = validateDeptName(name);
  if (!v.ok) return res.status(400).send(v.reason);
  try {
    const { DEPTS_DIR: DD } = require("../scripts/new-dept");
    const src = path.join(DD, name);
    if (!fs.existsSync(src)) return res.status(404).send("部門不存在");
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
    res.status(500).send(`刪除失敗: ${e.message}`);
  }
});

// ─── TG 登入 wizard ─────────────────────────────
const tgLogin = require("./lib/tg-login");

function renderDeptLogin(res, name, opts = {}, status = 200) {
  const dept = loadDeptForEdit(name);
  if (!dept) return res.status(404).send(`部門不存在: ${name}`);
  res.status(status).render("pages/dept-login", {
    title: `TG 登入 · ${name}`,
    active: "depts",
    deptName: name,
    outputChat: dept.config.outputChatName || "",
    step: opts.step || "phone",
    phone: opts.phone || null,
    error: opts.error || null,
    bytes: opts.bytes || null,
  });
}

app.get("/depts/:name/login", (req, res) => {
  const name = req.params.name;
  const status = tgLogin.getStatus(name);
  if (status.status === "awaiting_code") {
    return renderDeptLogin(res, name, { step: "code", phone: status.phone });
  }
  if (status.status === "awaiting_password") {
    return renderDeptLogin(res, name, { step: "password", phone: status.phone });
  }
  renderDeptLogin(res, name, { step: "phone" });
});

app.post("/depts/:name/login/phone", async (req, res) => {
  const name = req.params.name;
  const phone = String(req.body.phone || "").trim();
  try {
    await tgLogin.startLogin(name, phone);
    renderDeptLogin(res, name, { step: "code", phone });
  } catch (e) {
    console.error("[tg-login/phone]", e.message);
    renderDeptLogin(res, name, { step: "phone", phone, error: e.message }, 400);
  }
});

app.post("/depts/:name/login/code", async (req, res) => {
  const name = req.params.name;
  const code = String(req.body.code || "").trim();
  try {
    const result = await tgLogin.submitCode(name, code);
    if (result.status === "done") {
      return renderDeptLogin(res, name, { step: "done", bytes: result.bytes });
    }
    // 需要 2FA
    renderDeptLogin(res, name, { step: "password" });
  } catch (e) {
    console.error("[tg-login/code]", e.message);
    const status = tgLogin.getStatus(name);
    const step = status.status === "awaiting_password" ? "password" : "code";
    renderDeptLogin(res, name, { step, phone: status.phone, error: e.message }, 400);
  }
});

app.post("/depts/:name/login/password", async (req, res) => {
  const name = req.params.name;
  const password = String(req.body.password || "");
  try {
    const result = await tgLogin.submitPassword(name, password);
    renderDeptLogin(res, name, { step: "done", bytes: result.bytes });
  } catch (e) {
    console.error("[tg-login/password]", e.message);
    renderDeptLogin(res, name, { step: "password", error: e.message }, 400);
  }
});

app.post("/depts/:name/login/abort", (req, res) => {
  const name = req.params.name;
  tgLogin.abort(name);
  res.redirect(`/depts/${name}/login`);
});
app.get("/depts/:name",       (req, res) => res.redirect(`/depts/${req.params.name}/edit`));
app.get("/logs",                 placeholder("日誌", "即時 pm2 logs 串流", "v0.3 實作", "留到 v0.3。屆時可用 WebSocket 串 pm2 logs，按部門篩選 + 搜尋關鍵字。"));
app.get("/logs/:name",           placeholder("部門日誌", "單部門 pm2 logs", "v0.3 實作", "留到 v0.3。"));
// ─── /settings (全局進程 + healthcheck + 系統資訊) ───
const CRON_MARKER = "# tg-monitor-multi healthcheck";

function readHealthcheckStatus() {
  const { execFileSync } = require("child_process");
  let enabled = false;
  let cronLine = "";
  try {
    const out = execFileSync("crontab", ["-l"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const line = out.split("\n").find(l => l.includes(CRON_MARKER));
    if (line) {
      enabled = true;
      cronLine = line.trim();
    }
  } catch { /* crontab 可能不存在 */ }
  let logTail = "";
  const logPath = path.join(ROOT, ".healthcheck", "healthcheck.log");
  if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, "utf8").trim();
    logTail = content.split("\n").slice(-5).join("\n");
  }
  return { enabled, cronLine, logTail };
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
  const [globals, procs] = await Promise.all([
    loadGlobalsForSettings(),
    listAllProcesses(),
  ]);
  const GLOBAL_PURPOSES = {
    "title-sheet-writer":   "跨部門群名變更彙總 (訂閱多中轉群, 分流寫 Sheet)",
    "review-report-writer": "審查報告閉環跟蹤 (訂閱多審查報告群, 寫總表)",
  };
  const globalKindsWithPurpose = GLOBAL_KINDS.map(k => ({ kind: k, purpose: GLOBAL_PURPOSES[k] }));

  const healthcheck = readHealthcheckStatus();
  const backups = readBackupsSummary();
  const gsaExists = fs.existsSync(GOOGLE_SA_PATH);
  let gsaEmail = "";
  if (gsaExists) {
    try { gsaEmail = JSON.parse(fs.readFileSync(GOOGLE_SA_PATH, "utf8")).client_email || ""; } catch {}
  }

  const systemInfo = {
    version: VERSION,
    mode: dataProvider.MODE,
    root: ROOT,
    nodeVersion: process.version,
    gsaExists,
    gsaEmail,
    pm2Available: true, // 之後可真的跑 pm2 -v 檢查, MVP 先假設
  };

  res.render("pages/settings", {
    title: "系統設置",
    active: "settings",
    globals,
    globalKinds: globalKindsWithPurpose,
    procs,
    healthcheck,
    backups,
    systemInfo,
    flash: req.query.flash || null,
    error: req.query.error || null,
  });
});

// ─── 建立全局進程 ───────────────────────────────
app.post("/settings/global/new", async (req, res) => {
  const { kind } = req.body;
  try {
    const sys = fs.existsSync(SYSTEM_JSON) ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8")) : {};
    const result = await createGlobal(kind, { tgApiId: sys.tgApiId, tgApiHash: sys.tgApiHash });
    await regenerateEcosystem();
    res.redirect(`/settings?flash=${encodeURIComponent(`已建立 global/${result.kind}/, 下一步: SSH 到 VPS 跑 node scripts/login-global.js ${result.kind}`)}`);
  } catch (e) {
    console.error("[settings/global/new]", e.message);
    res.redirect(`/settings?error=${encodeURIComponent(e.message)}`);
  }
});

// ─── 全局進程 PM2 控制 ───────────────────────────
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
      if (!fs.existsSync(ecoPath)) throw new Error("ecosystem.config.js 不存在, 先建立全局進程");
      await new Promise(r => execFile("pm2", ["start", ecoPath, "--only", procName], { cwd: ROOT }, (err, _o, _e) => r()));
    } else {
      await pm2Exec(action, procName);
    }
    res.redirect(`/settings?flash=${encodeURIComponent(`已觸發 pm2 ${action} ${procName}`)}`);
  } catch (e) {
    res.redirect(`/settings?error=${encodeURIComponent(e.message)}`);
  }
});

// ─── Healthcheck 啟用 / 停用 ───────────────────
function runHealthcheckInstall(arg) {
  return new Promise((resolve, reject) => {
    const script = path.join(ROOT, "scripts", "install-healthcheck.sh");
    execFile("bash", [script, arg], { cwd: ROOT }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}
app.post("/settings/healthcheck/install", async (_req, res) => {
  try {
    await runHealthcheckInstall("install");
    res.redirect(`/settings?flash=${encodeURIComponent("Healthcheck cron 已啟用 (每 5 分鐘)")}`);
  } catch (e) {
    res.redirect(`/settings?error=${encodeURIComponent(`啟用失敗: ${e.message}`)}`);
  }
});
app.post("/settings/healthcheck/remove", async (_req, res) => {
  try {
    await runHealthcheckInstall("--remove");
    res.redirect(`/settings?flash=${encodeURIComponent("Healthcheck cron 已停用")}`);
  } catch (e) {
    res.redirect(`/settings?error=${encodeURIComponent(`停用失敗: ${e.message}`)}`);
  }
});

// ─── 404 ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).render("pages/placeholder", {
    title: "404",
    subtitle: "頁面不存在",
    stage: "",
    description: "你訪問的路徑不存在。返回總覽看看？",
    active: "",
  });
});

// ─── 啟動 ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("╔════════════════════════════════════════════════════════");
  console.log("║  tg-monitor-multi · v" + VERSION);
  console.log("║  mode:   " + dataProvider.MODE.toUpperCase());
  console.log("║  listen: http://localhost:" + PORT);
  console.log("║  root:   " + ROOT);
  if (process.env.TG_MONITOR_MULTI_DOCKER === "1") {
    console.log("║  env:    DOCKER (tg-* 進程由本 Web 的同 pm2 daemon 管)");
  }
  console.log("╚════════════════════════════════════════════════════════");

  // 啟動時: 若 ecosystem.config.js 存在且含進程定義, 自動 pm2 start
  // (讓容器重啟 / 服務重啟後, 既有部門進程自動拉起)
  const ecoPath = path.join(ROOT, "ecosystem.config.js");
  if (fs.existsSync(ecoPath)) {
    try {
      const content = fs.readFileSync(ecoPath, "utf8");
      if (content.includes('"name"')) {
        console.log("[boot] 偵測到 ecosystem.config.js 含進程定義, 嘗試 pm2 start...");
        execFile("pm2", ["start", ecoPath], { cwd: ROOT }, (err, stdout, stderr) => {
          if (err) {
            console.warn("[boot] pm2 start ecosystem 失敗:", (stderr || err.message).split("\n")[0]);
          } else {
            console.log("[boot] ecosystem 載入完成");
          }
        });
      }
    } catch (e) {
      console.warn("[boot] 讀 ecosystem.config.js 失敗:", e.message);
    }
  }
});
