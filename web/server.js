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
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const dataProvider = require("./lib/data-provider");
const { createDept, validateDeptName } = require("../scripts/new-dept");

const app = express();
const PORT = Number(process.env.PORT || 5003);
const ROOT = path.resolve(__dirname, "..");
const VERSION = require("../package.json").version;
const DATA_DIR = path.join(ROOT, "data");
const SYSTEM_JSON = path.join(DATA_DIR, "system.json");

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
app.get("/setup", (_req, res) => {
  res.render("pages/setup", {
    title: "首次設置",
    showNav: false,
    active: "",
  });
});

app.post("/setup", async (req, res) => {
  // 第 1 批: 真的寫 data/system.json + 建第一個部門目錄 + 重新生成 ecosystem
  const {
    admin_username, admin_password,
    tg_api_id, tg_api_hash,
    dept_name, dept_display, output_chat, spreadsheet_id, sheet_tab,
  } = req.body;

  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // 1. 寫 system.json（未加密保存，MVP 簡化；v0.6 加 bcrypt）
    const sys = fs.existsSync(SYSTEM_JSON)
      ? JSON.parse(fs.readFileSync(SYSTEM_JSON, "utf8"))
      : {};
    Object.assign(sys, {
      setupComplete: true,
      setupAt: new Date().toISOString(),
      adminUsername: admin_username || "admin",
      // MVP: 密碼先明文存（v0.6 改 bcrypt）
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
    res.status(400).render("pages/placeholder", {
      title: "設置失敗",
      subtitle: "",
      stage: "",
      description: `原因: ${e.message}. 請返回重試。`,
      active: "",
    });
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
app.get("/depts/new", (_req, res) => {
  res.render("pages/dept-new", {
    title: "新增部門",
    active: "depts",
  });
});

app.post("/depts/new", async (req, res) => {
  const { dept_name, dept_display, output_chat, spreadsheet_id, sheet_tab } = req.body;
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
    res.status(400).render("pages/placeholder", {
      title: "新增部門失敗",
      subtitle: "",
      stage: "",
      description: `原因: ${e.message}`,
      active: "depts",
    });
  }
});
app.get("/depts/:name/edit",     placeholder("編輯部門", "修改 config.json", "D5 實作", "預計 D5 (4/20) 完成。屆時可線上編輯中轉群名 / Spreadsheet ID / 關鍵字列表 / 冷卻時間等。保存即重啟對應進程。"));
app.get("/depts/:name/login",    placeholder("TG 登入", "手機號 → 驗證碼 → 兩步驗證", "v0.3 實作", "留到 v0.3。目前需在 VPS 上手動跑 node scripts/login-dept.js 完成登入。"));
app.get("/depts/:name",          (req, res) => res.redirect(`/depts/${req.params.name}/edit`));
app.get("/logs",                 placeholder("日誌", "即時 pm2 logs 串流", "v0.3 實作", "留到 v0.3。屆時可用 WebSocket 串 pm2 logs，按部門篩選 + 搜尋關鍵字。"));
app.get("/logs/:name",           placeholder("部門日誌", "單部門 pm2 logs", "v0.3 實作", "留到 v0.3。"));
app.get("/settings",             placeholder("系統設置", "用戶管理 / 系統配置", "v0.3 實作", "留到 v0.3。屆時管理員可新增/移除 Web 用戶、修改系統級配置、輪換 TG API / Google SA。"));

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
  console.log("╚════════════════════════════════════════════════════════");
});
