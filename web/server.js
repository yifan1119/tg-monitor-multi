// tg-monitor-multi — Web Dashboard
// MVP 骨架。D3-D5 會填實際功能。
//
// 啟動：
//   cd web && npm install && npm start
//   瀏覽 http://localhost:5003

const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 5003);
const ROOT = path.resolve(__dirname, "..");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "templates"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── 健康檢查 ────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: require("../package.json").version,
    root: ROOT,
    time: new Date().toISOString(),
  });
});

// ─── 首頁佔位（D3 會改成 dashboard 或自動轉 setup） ───────
app.get("/", (_req, res) => {
  res.send(`
    <h1>tg-monitor-multi · v0.2.0-mvp (D1 skeleton)</h1>
    <p>D3 起會把 dashboard / setup wizard 填進來。</p>
    <ul>
      <li><a href="/health">/health</a></li>
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log(`[tg-monitor-multi-web] listening on http://localhost:${PORT}`);
  console.log(`[tg-monitor-multi-web] project root: ${ROOT}`);
});
