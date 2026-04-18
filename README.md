# tg-monitor-multi

**多部门 Telegram 业务群监控系统**

一台 VPS 跑 N 个部门，每部门一个 TG 真人号监听业务群。命中关键字（到期 / 下架 / 打款 / 欠费…）自动推中转群 + 写 Google Sheet；群改名也记一条。

姊妹项目 [`tg-monitor-template`](https://github.com/yifan1119/tg-monitor-template)：**外事号私聊**监控（1 客户 1 VPS）；本 repo 聚焦**业务群**监控（1 VPS N 部门）。

---

## 目录

- [一键部署](#一键部署)
- [设置向导 (Setup Wizard)](#设置向导-setup-wizard)
- [TG 登入 + 启动](#tg-登入--启动)
- [功能全览](#功能全览)
- [HTTPS 启用](#https-启用)
- [外部 API（中央看板接入）](#外部-api中央看板接入)
- [TG Bot 绑定 + 忘记密码](#tg-bot-绑定--忘记密码)
- [日常运维（全在 Web）](#日常运维全在-web)
- [升级 · 回滚 · 备份](#升级--回滚--备份)
- [多实例部署（SaaS 场景）](#多实例部署saas-场景)
- [卸载](#卸载)
- [架构 & 敏感文件](#架构--敏感文件)
- [安全建议](#安全建议)

---

## 一键部署

**客户自己有 VPS（最常见）**

```bash
curl -fsSL https://raw.githubusercontent.com/yifan1119/tg-monitor-multi/main/install.sh -o install.sh && bash install.sh --https
```

自动：装 Docker → clone → 检测空闲端口 → 拉镜像 → 开启 HTTPS（Caddy + Let's Encrypt 自动证书）。

3-5 分钟跑完，终端会印浏览器地址：
```
https://multi.<VPS_IP>.nip.io/setup
```

**可选环境变量**
```bash
INSTALL_DIR=/opt/my-tg     # 自定义安装路径
WEB_PORT=5010              # 指定端口（默认 5003，被占自动往上找）
WEB_PORT_AUTO=0            # 强制用 WEB_PORT，被占就报错
BRANCH=main                # git 分支
bash install.sh --https
```

**不要 HTTPS？** 去掉 `--https` 即可。只跑 HTTP（对内网 OK，对公网不推荐）。

---

## 设置向导 (Setup Wizard)

浏览器 `/setup` 走 4 步：

1. **Web 管理员帐密**（密码 ≥ 8 位，会 bcrypt hash 存储）
2. **TG API ID / Hash**（去 [my.telegram.org/apps](https://my.telegram.org/apps) 拿）
3. **上传 Google Service Account JSON**（GCP Console → IAM → Service Accounts → 建 key → 下载 JSON）
4. **第一个部门**
   - 部门代号：小写字母 + 数字（`yueda`、`dept-01`）
   - 显示名：可中文（`悦达`）
   - 中转群名：业务群的 TG 名（`悦达-业务审查`）
   - Spreadsheet ID：从 Sheet URL `/d/<这段>/edit` 取
   - 工作表分页名：**留空自动生成** `关键词命中-<部门代号>`

提交后自动：
- 在你的 Google Sheet 里建 2 个分页（关键词命中 + 群名变更），套好标题 / 表头 / 斑马纹 / 冻结
- 生成 PM2 配置
- 自动登入你（管理员）到 Dashboard

---

## TG 登入 + 启动

Dashboard → 点部门卡片 → **🔑 去登入 TG**
手机号 → 验证码 → （2FA 就填）→ `session.txt` 自动写入。

点 **▶ 启动**，worker 开始运行（PM2 名：`tg-worker-<部门>`）。

> **只监听启动后的消息**：worker 启动之后的新消息才进 Sheet，历史不回灌。

---

## 功能全览

| 功能 | 怎么触发 | 写到哪 |
|------|---------|-------|
| **关键字命中** | 业务群里有人发命中的词（到期 / 下架 / 打款 …）| 中转群 + 关键词命中分页 |
| **群名变更** | TG 群改名 | 群名变更分页 |
| **冷却去重** | 同群同关键字 10 分钟内不刷屏 | — |
| **backfill 防漏网** | 每 60s 扫近 30 条 | — |
| **Sheet 写入串行** | 单 worker Promise 队列 | 避免并发 insertDimension 空行/覆盖 |
| **原群名缓存** | 启动扫一遍 + 每 30min 刷 | `state/title-cache.json` |
| **pending retry** | Sheet 写失败追加到 jsonl，每 60s 重试 | `state/pending-writes.jsonl` |
| **Session 死亡检测** | worker 60s 心跳 `getMe()`，被踢就退出 + DM 告警 | `state/session-dead.json` + bot DM |
| **健康检查自愈** | 容器内每 5 分钟扫 `tg-*` 挂了的重启（worker 不重启，避免 TG session 掉）| `/ops` 页可开关 |

---

## HTTPS 启用

**首次装就开**（推荐）：`bash install.sh --https`

**装完后再开**：
```bash
cd /opt/tg-monitor-multi && bash scripts/enable-https.sh
```

**指定自己的域名**：
```bash
bash scripts/enable-https.sh tg.mycompany.com
```
（先把 A 记录指到 VPS）

**智能模式**：
- 80/443 空闲 → 自建 Caddy 容器
- 80/443 被别的 Caddy 占（比如姊妹项目）→ **共享模式**：往现成 Caddy 追加 site block + reload，不抢端口
- 80/443 被非 Caddy 占 → 报错指南，需要先停掉占用者

**nip.io 域名**：自动用 `multi.<VPS_IP>.nip.io`（多实例场景不撞）。

> Let's Encrypt HTTP-01 challenge 要 80 端口对公网开放。

---

## 外部 API（中央看板接入）

**`GET /api/v1/metrics`** — Bearer token 鉴权，返回系统 snapshot。

拿 token：`/settings` → 「外部 API · 中央看板接入」→ 复制

```bash
curl -H "Authorization: Bearer <token>" \
  https://multi.<VPS_IP>.nip.io/api/v1/metrics
```

**返回 schema**（和姊妹项目 `tg-monitor-template` 对齐，中央看板可以一套代码吃两种）：
```json
{
  "ok": true,
  "ts": "2026-04-18 14:30:00",
  "product": "tg-monitor-multi",
  "instance": "",
  "version": "0.3.1-docker",
  "system": {
    "listener_online": 3,
    "listener_warn": 0,
    "listener_dead": 1,
    "listener_total": 4
  },
  "alerts_today": { "total": 23, "keyword": 23, "title_change": 0 },
  "accounts": [
    { "name": "yueda", "display": "悦达", "heartbeat_status": "online", "hit_24h": 17, ... }
  ],
  "alerts_recent": [...],
  "update": { "has_update": false, ... }
}
```

`/settings` 还能看**最近调用次数**和**重置 token**。

**安全**：
- 公网暴露前请启 HTTPS（HTTP 下 Bearer token 会明文传输）
- 鉴权用 `timingSafeEqual`，防时序攻击

---

## TG Bot 绑定 + 忘记密码

没绑过：忘密只能 SSH 到服务器手动改 `data/system.json`，**极其推荐绑一次**。

**步骤**：
1. TG 找 `@BotFather` → `/newbot` → 起名 → 拿 token
2. Web `/settings` → 「账号安全 · TG Bot 绑定」→ 粘 token → 保存（bot 自动启动）
3. 点「生成绑定码」→ 拿到 6 位码（10 分钟有效）
4. 在 bot 里先 `/start`，然后发 `/bind ABC123`
5. 绑定成功

**忘密流程**：
- `/login` 页 →「忘记密码?」→ 填用户名
- bot DM 发 6 位验证码（5 分钟有效，5 次错尝试作废）
- 填码 + 新密码 → 重置成功

**Bot 其他用途**
- Session 死亡自动告警（worker 被踢时 DM 管理员，5 分钟内）

---

## 日常运维（全在 Web）

| 操作 | 路径 |
|------|------|
| 总览 | `/dashboard` |
| 部门列表 / 新增 | `/depts` |
| 编辑部门 / 启停 / 删除 | `/depts/:name/edit` |
| TG 登入 | `/depts/:name/login` |
| 系统设置（TG API / SA / Bot / Token） | `/settings` |
| 健康检查 / 升级 / 备份 / 回滚 | `/ops` |
| 登出 | 右上角 |

**安全机制**
- 登入失败 5 次锁 IP 15 分钟
- 所有关键操作（登入 / 改密 / token 重置 / bot 绑定）都写 append-only 审计日志 `data/auth-audit.log`
- 密码 bcrypt hash 存储，cookie 用 HMAC 签名

---

## 升级 · 回滚 · 备份

### 升级

**Web 按钮**（90% 场景）：
`/ops` → 检查更新 → 软升级
- 自动备份 → `git pull` → `pm2 reload tg-*`
- 网页后台本身不重启
- 改了 Dockerfile / package.json 时会禁用软升级，提示 SSH

**SSH**（需要重建镜像时）：
```bash
cd /opt/tg-monitor-multi && bash scripts/update.sh
```

代码目录（web/shared/scripts/.git）是 **bind mount**，小改动不用 rebuild。

### 备份

每次软升级 / 回滚前自动备份：
- `depts/ global/ data/ secrets/` → `.backups/<时间戳>/`
- `/ops` 可以看所有备份 + 点「↶ 回滚」

### 回滚

`/ops` → 备份列表 → 「↶ 回滚」
或 CLI：`bash scripts/rollback.sh .backups/<时间戳>/`

回滚前会**再备份一次当前**（`.backups/<ts>-pre-rollback/`），回滚本身可回滚。

---

## 多实例部署（SaaS 场景）

一台 VPS 跑多份，给不同客户独立空间：

```bash
# 客户 suzong
bash install.sh suzong --https
# → /opt/tg-monitor-multi-suzong/
# → 容器 tg-monitor-multi-suzong
# → HTTPS multi-suzong.<IP>.nip.io

# 客户 client-a
bash install.sh client-a --https
# → 完全独立
```

**每个实例独立**：容器 / 镜像 / depts / Sheet / Web 帐密 / token / bot / session.txt 全都不相干。

**共享**：只共享宿主机 Caddy（自动追加 site block，不互相撞）。

**姊妹项目 `tg-caddy-demo` 已在跑？** 自动进入共享模式，用同一个 Caddy。

顶栏会显示当前实例名（默认实例不显示）：
```
TG-MONITOR-MULTI · suzong    v0.3.1-docker
```

---

## 卸载

```bash
cd /opt/tg-monitor-multi && bash scripts/uninstall.sh
```

默认**保留数据**（depts / data / secrets 移到 `/root/tg-monitor-backup-<ts>/`），给客户留出后路。

**彻底删干净**：
```bash
bash scripts/uninstall.sh --purge --force
```

自动：停容器 → 删镜像 → 清 Caddy 里本实例的 site block + reload → 删目录。

**多实例场景**：
```bash
cd /opt/tg-monitor-multi-suzong && bash scripts/uninstall.sh suzong --purge
```
精准只删 suzong，不误动其他实例。

---

## 架构 & 敏感文件

```
TG 业务群 (每部门加入 N 个客户群)
        │
        ↓  gram.js NewMessage event
   ┌─────────────────────────────┐
   │ tg-worker-<部门>             │
   │ - 命中关键字 → 推中转群       │
   │ - 命中 → 写关键词 Sheet       │
   │ - 群改名 → 写变更 Sheet       │
   │ - session 死亡 → 自愿退出     │
   └───────┬────────────┬─────────┘
           │            │
           ↓            ↓
      TG 中转群     Google Sheet
    (主管看)      (2 个分页 / 部门)
```

**容器内布局**：
```
/app/
├── web/server.js         ← tg-monitor-web (PID 1 via pm2-runtime)
│   ├── tg-monitor-web    Web + API
│   ├── tg-worker-<d1>    部门 1 worker (Web 内部启动)
│   ├── tg-worker-<d2>    部门 2 worker
│   └── ...
└── shared/google-service-account.json  ← bind mount
```

**敏感文件（已 `.gitignore`）**

| 文件 | 泄漏后果 |
|------|---------|
| `depts/*/session.txt` | ⚠ TG 账号被接管 |
| `depts/*/.env` | ⚠ TG API 滥用 |
| `secrets/google-service-account.json` | ⚠ Google 资源被盗 |
| `data/system.json` | ⚠ Web 后台被接管（含 bot token / metrics token / bcrypt hash）|

> 建议 `session.txt` 用 `age` 或 `gpg` 加密备份，因为这是 N 个 TG 真人号的命根子。

---

## 安全建议

- ✓ 密码 bcrypt hash + HMAC 签名 cookie
- ✓ IP 登入失败 5 次锁 15 分钟
- ✓ 审计日志 append-only
- ✓ 外部 API timingSafeEqual 防时序
- ✓ HTTPS 一键启用（Let's Encrypt 自动续签）

**运维建议**
- Port 默认对公网开放 → 用防火墙或 Caddy 前面反代
- `chmod 600 data/system.json secrets/*`
- 绑定 TG Bot（忘密 + session 告警）
- 启用 `/ops` 健康检查（5 分钟自愈）

---

## 相关

- 完整改动：[CHANGELOG.md](CHANGELOG.md)
- 姊妹项目（私聊监控）：[tg-monitor-template](https://github.com/yifan1119/tg-monitor-template)

未释出对外授权（Private repo 使用）。
