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
const dataProvider = require("./lib/data-provider");

const app = express();
const PORT = Number(process.env.PORT || 5003);
const ROOT = path.resolve(__dirname, "..");
const VERSION = require("../package.json").version;

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

app.post("/setup", (_req, res) => {
  // MVP 佔位 (D5 會真的寫 .env / 建部門 / 觸發 TG 登入)
  res.redirect("/dashboard?setup=done");
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

app.get("/depts/new",            placeholder("新增部門", "加入第一個或下一個部門", "D5 實作", "預計 D5 (4/20) 完成。屆時此頁為完整表單，填完提交 → 自動建 depts/<name>/ → 跳 TG 登入 wizard。"));
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
