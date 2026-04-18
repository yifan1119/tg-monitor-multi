# tg-monitor-multi

**多部门 Telegram 业务群监控系统**

一台 VPS 跑 N 个部门，每部门一个 TG 真人号监听业务群。命中关键字（到期 / 下架 / 打款 / 欠费…）自动推中转群 + 写 Google Sheet；群名被改也记一条。

姊妹项目 [`tg-monitor-template`](https://github.com/yifan1119/tg-monitor-template) 是**外事号私聊**监控（1 客户 1 VPS）；本 repo 聚焦**业务群**监控（1 VPS N 部门）。

---

## 一键装

```bash
curl -fsSL https://raw.githubusercontent.com/yifan1119/tg-monitor-multi/main/install.sh | bash
```

脚本会：装 Docker → clone → 检测空闲端口（默认 5003，被占自动往上找） → `docker compose up -d`。

装到别处 / 强制端口：
```bash
INSTALL_DIR=/opt/tg-mm WEB_PORT=5010 WEB_PORT_AUTO=0 bash install.sh
```

装完终端会印 `http://<VPS_IP>:<端口>/setup`，开浏览器继续。

---

## 设置向导（浏览器里走）

`/setup` 四步：
1. Web 管理员帐密
2. TG API ID / Hash（[my.telegram.org/apps](https://my.telegram.org/apps) 拿）
3. 上传 Google Service Account JSON
4. 第一个部门（代号 / 中转群名 / Sheet ID — 分页名可留空自动生成）

提交后会自动在你的 Sheet 建两个分页：`关键词命中-<部门>` + `群名变更-<部门>`，含标题、表头、斑马纹、列宽、冻结。

---

## TG 登入 + 启动

1. 回到 `/dashboard` → 点部门卡片 → **🔑 去登入 TG**
2. 手机号 → 验证码 → （有 2FA 就填）→ `session.txt` 自动写入
3. 点 **▶ 启动**

一个部门一个 worker 进程（PM2 名：`tg-worker-<部门>`），集监听、推送、写 Sheet 于一身。

> **登入后才开始记**：worker 启动那一刻后的消息才进 Sheet，历史消息不回灌。

---

## 架构（简图）

```
TG 业务群 (每部门加入 N 个客户群)
        │
        ↓  NewMessage event
   ┌─────────────────────────────┐
   │   tg-worker-<部门>           │
   │   - 命中关键字 → 推中转群    │
   │   - 命中 → 写关键词 Sheet    │
   │   - 群改名 → 写变更 Sheet    │
   │   - 10 min 冷却防刷屏        │
   │   - 60s backfill 防丢事件    │
   └───────┬────────────┬─────────┘
           │            │
           ↓            ↓
      TG 中转群     Google Sheet
    (主管看)      (2 个分页 / 部门)
```

每部门目录独立：`depts/<部门>/{config.json, .env, session.txt, state/}`。互不影响。

---

## 日常操作（全部在 Web）

| 操作 | 路径 |
|------|------|
| 总览 | `/dashboard` |
| 部门列表 / 新增 | `/depts` |
| 编辑 / 启停 / 删除部门 | `/depts/:name/edit` |
| TG 登入 | `/depts/:name/login` |
| 健康检查 / 升级 / 回滚 / 备份 | `/ops` |
| TG API / SA / 管理员 | `/settings` |

---

## 升级

```bash
# 大多数改动 (模板 / 业务代码)
Web → /ops → 检查更新 → 软升级   # git pull + pm2 reload, 网页后台不重启

# 改 Dockerfile / package.json 时会提示 SSH
cd /opt/tg-monitor-multi && git pull && docker compose up -d
```

代码 (`web/` `shared/` `scripts/`) 和 `.git` 都是 bind mount — 软升级后直接生效，不用 rebuild 镜像。

每次软升级 / 回滚自动备份 `depts/ global/ data/ secrets/` 到 `.backups/<时间戳>/`。回滚：`/ops` → 备份列表点「↶ 回滚」。

---

## 健康检查

`/ops` 一键启用：容器内每 5 分钟扫 `tg-*` 服务，挂了自动重启。**worker 故意不自动重启** — 挂通常是 session 失效，要人工重登。

---

## 敏感文件（已 `.gitignore`）

| 文件 | 泄漏后果 |
|------|---------|
| `depts/*/session.txt` | ⚠ TG 账号被接管 |
| `depts/*/.env` | ⚠ API 滥用 |
| `secrets/google-service-account.json` | ⚠ Google 资源被盗 |
| `data/system.json` | ⚠ Web 后台被接管 |

> 建议对 session.txt 做加密备份（`age` / `gpg`）。这是 N 个 TG 真人号的命根子。

---

## HTTPS（一键启用，无需域名）

要给中央看板 / 老板提供正经 URL，上 HTTPS 就行：

```bash
# 无域名 (用 nip.io 把 IP 转域名):
bash scripts/enable-https.sh

# 有自己的域名 (先把 A 记录指到 VPS):
bash scripts/enable-https.sh tg.mycompany.com
```

做什么：
1. 自动决定 `PUBLIC_DOMAIN`（nip.io 或你给的）
2. 检查 80/443 空闲，拉起 Caddy 容器
3. Caddy 从 Let's Encrypt 自动申请 + 续签证书
4. 访问 `https://<PUBLIC_DOMAIN>/` → 反代到 Web 容器

**首次装就想启 HTTPS**：
```bash
curl -fsSL https://raw.githubusercontent.com/yifan1119/tg-monitor-multi/main/install.sh -o install.sh && bash install.sh --https
```

**前提**：VPS 80/443 对外开放（Let's Encrypt HTTP-01 验证要用）。

---

## 安全

- Port 默认不对公网开 → 防火墙挡
- 要公网访问 → 用上面的 HTTPS 一键脚本
- `chmod 600 data/system.json secrets/*`
- MVP 不做 CSRF / rate limit（内部工具够用）

---

## 相关

- 完整改动：[CHANGELOG.md](CHANGELOG.md)
- 裸跑模式（不用 Docker）：[docs/DEPLOY-BARE.md](docs/DEPLOY-BARE.md)
- 姊妹项目（私聊监控）：[tg-monitor-template](https://github.com/yifan1119/tg-monitor-template)

未释出对外授权（Private repo 使用）。
