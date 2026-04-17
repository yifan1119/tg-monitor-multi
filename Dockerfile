# tg-monitor-multi — 單容器 Dockerfile (multi-stage build)
#
# Builder stage: 裝編譯工具 (python3/make/g++) 以 build native modules (bufferutil 等)
# Final stage:   只保留 runtime (bash/tini/curl/pm2), image 輕量
#
# PID 1: tini → pm2-runtime → web/server.js
# 其他 tg-* 進程由 Web 內部動態 pm2 start 加載, 同個 pm2 daemon 管理

# ─── Stage 1: Builder ────────────────────────────────
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# 複製 workspaces 的 manifests
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY web/package.json ./web/package.json

# 一次裝所有 workspace 依賴 (native 模組在此 stage 編譯)
RUN npm ci

# ─── Stage 2: Final ──────────────────────────────────
FROM node:22-alpine

# Runtime 工具 (無編譯依賴)
# git: Web 「检查更新」/ softUpdate 需要 git fetch + git pull
RUN apk add --no-cache bash tini curl git \
 && npm install -g pm2@6 --silent

WORKDIR /app

# 從 builder 複製已編譯好的 node_modules (native 模組也在裡面)
COPY --from=builder /app/node_modules ./node_modules

# 代碼 (shared/, web/, scripts/ 等, workspace 機制下 node_modules hoist 到根)
COPY . .

# 腳本權限
RUN chmod +x scripts/*.sh install.sh install-bare.sh 2>/dev/null || true

# 標記: 容器內環境
ENV NODE_ENV=production \
    DATA_PROVIDER=real \
    WEB_PORT=5003 \
    TG_MONITOR_MULTI_DOCKER=1

EXPOSE 5003

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:5003/health || exit 1

# PID 1: tini (zombie 清理 + 信號轉發)
# Main: pm2-runtime 跑 Web, Web 動態加載 tg-* 進程
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pm2-runtime", "start", "/app/web/server.js", "--name", "tg-monitor-web"]
