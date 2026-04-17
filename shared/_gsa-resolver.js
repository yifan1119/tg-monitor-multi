// shared/_gsa-resolver.js
//
// 找 Google SA 档案的帮手. 按优先级尝试多处:
//   1. cwd 下的 ./google-service-account.json (baseline 兼容: 苏总每个进程目录自己一份)
//   2. <project-root>/shared/google-service-account.json (multi 主路径, Docker volume mount 入这)
//   3. <project-root>/secrets/google-service-account.json (docker-compose 宿主机目录)
//
// 路径一 = baseline, 保留让 multi 版本也能沿用 baseline 风格部署.
// 路径二 = multi + Docker 主推 (docker-compose 把 secrets/google-service-account.json mount 到
//          /app/shared/google-service-account.json).
// 路径三 = 裸跑 + 手动放 secrets/ 的情况.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function findGsa() {
  const candidates = [
    path.resolve(process.cwd(), "google-service-account.json"),
    path.join(ROOT, "shared", "google-service-account.json"),
    path.join(ROOT, "secrets", "google-service-account.json"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 100) return p;
    } catch {}
  }
  return null;
}

function requireGsa() {
  const p = findGsa();
  if (!p) {
    console.error("缺少 google-service-account.json");
    console.error("  已搜索:");
    console.error("    1. " + path.resolve(process.cwd(), "google-service-account.json"));
    console.error("    2. " + path.join(ROOT, "shared", "google-service-account.json"));
    console.error("    3. " + path.join(ROOT, "secrets", "google-service-account.json"));
    console.error("  请到 Web /setup 上传 Google SA JSON, 或手动放到 secrets/google-service-account.json");
    process.exit(1);
  }
  return p;
}

module.exports = { findGsa, requireGsa };
