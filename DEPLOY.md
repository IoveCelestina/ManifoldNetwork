# ManifoldNetwork chat-demo 服务器部署

chat-demo 是个**相对独立**的应用（静态前端 + 服务端推理/鉴权 + 会话存储 SQLite）。0b 起凭证活在服务端
session（浏览器只持 httpOnly cookie），聊天/生图由后端用 session 里的 key 调上游。两种上线姿势：

- **方式 A（本项目实际采用）**：服务器上已有 Caddy + sub2api，把 chat-demo 接进同一 docker 网络、用现成 Caddy 反代。← **chat.zstuacm.xyz 就是这么跑的。**
- **方式 B（独立部署）**：没有现成反代时，用仓库自带 `docker-compose.yml`（Cloudflare Tunnel，零入站端口）。见文末。

---

## 方式 A：接入现有 Caddy 栈（实际部署）

```
浏览器 ──HTTPS──> Cloudflare (chat.zstuacm.xyz)
                      ▼
                 manifold-caddy（终结 TLS，自动 Let's Encrypt 证书）
                      │  reverse_proxy（manifold-edge 网络内）
                      ▼
                 manifold-chat-demo:8787
                      ├─ 静态前端 + /store（SQLite，按 sub2api user_id 隔离）
                      └─ 同源代理 ──> manifold-sub2api:8080
```

**前提**：服务器已有 `manifold` 栈（`/opt/manifold/deploy/`），Caddy 与 sub2api 都在 `manifold-edge`
网络上；sub2api 容器名 `manifold-sub2api`、听 8080（不发布宿主机端口）。容器/网络名按你实际的改。

### 1. 克隆仓库

```bash
git clone https://github.com/IoveCelestina/ManifoldNetwork.git /opt/manifold/chat-demo
```

### 2. 写接入用 compose：`/opt/manifold/chat-demo/compose.edge.yml`

挂进现有 `manifold-edge`、直连 `manifold-sub2api:8080`、不发布端口、不要 cloudflared：

```yaml
name: manifold-chat
services:
  chat-demo:
    build: .
    image: manifold/chat-demo:local
    container_name: manifold-chat-demo
    restart: unless-stopped
    stop_grace_period: 35s                # 优雅关闭：留时间排空在途 SSE 流（配合 SHUTDOWN_TIMEOUT_MS=30000）
    environment:
      SUB2API_BASE: http://manifold-sub2api:8080
      PORT: "8787"
      DB_PATH: /data/manifold.db
      NODE_OPTIONS: --no-warnings
      TZ: Asia/Shanghai
    volumes:
      - chat-data:/data
    networks:
      - manifold-edge
networks:
  manifold-edge:
    external: true
    name: manifold-edge
volumes:
  chat-data:
    name: manifold-chat-data
```

### 3. 构建并启动

```bash
cd /opt/manifold/chat-demo
docker compose -f compose.edge.yml up -d --build
docker compose -f compose.edge.yml ps      # chat-demo 应为 healthy
```

### 4. DNS：加子域名

Cloudflare 面板 → zstuacm.xyz → DNS → Add record：

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `chat` | `zstuacm.xyz` | Proxied（橙云） |

### 5. Caddy 反代（改完热加载，不停服）

编辑 `/opt/manifold/deploy/Caddyfile`，**先备份**，文件末尾追加一段：

```caddyfile
chat.zstuacm.xyz {
    encode gzip zstd
    reverse_proxy manifold-chat-demo:8787 {
        header_up X-Real-IP {client_ip}
        header_up X-Forwarded-For {client_ip}
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options nosniff
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }
}
```

校验 + 热加载（validate 失败就别 reload，先还原备份）：

```bash
cd /opt/manifold/deploy
cp Caddyfile Caddyfile.bak.chat.$(date +%Y%m%d-%H%M%S)
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec -T caddy caddy reload  --config /etc/caddy/Caddyfile
```

Caddy 会自动给 `chat.zstuacm.xyz` 签 Let's Encrypt 证书（和主站同机制，约十几秒）。

### 6. 验证

```bash
# 源站直测（绕过 CF，验证证书 + 反代）
curl -sS --resolve chat.zstuacm.xyz:443:127.0.0.1 https://chat.zstuacm.xyz/ \
  -o /dev/null -w 'HTTP %{http_code} | TLS %{ssl_verify_result}\n'        # 期望 200 | 0

# 应用接口 + 代理链路（经 CF 整条）
curl -sS https://chat.zstuacm.xyz/api/session/me      # 期望 200 {"email":null,...}（新应用接口活着）
curl -sS https://chat.zstuacm.xyz/store/conversations # 期望 401 未登录
curl -sS https://chat.zstuacm.xyz/v1/models           # 期望 401（LEGACY_PROXY=on 时代理上游；下线后为 404）
```

浏览器开 `https://chat.zstuacm.xyz`，账号密码登录。

### 更新 / 下线

```bash
# 更新（push 新代码后）
cd /opt/manifold/chat-demo && git pull && docker compose -f compose.edge.yml up -d --build

# 日志
docker logs -f manifold-chat-demo

# 下线 chat-demo（不影响 sub2api）：删容器，再去掉 Caddy 的 chat 段 + reload + 删 DNS
docker compose -f compose.edge.yml down          # 加 -v 连对话数据卷一起删（不可逆）
```

---

## 数据与备份

升级到「按账号同步对话」后，**服务端不再是零状态**：对话存在 chat-demo 容器内的 SQLite
（`DB_PATH=/data/manifold.db`，落命名卷 `manifold-chat-data`）。身份与计费仍走 sub2api。
⚠ **0b 起 SQLite 还存了 `sessions` 表（含 sub2api 的 jwt/refresh + 选中的 API key 明文）**——DB 成了秘密载体：
卷权限要收紧，**备份产物同样含密钥，需同等保护**（加密存放、限制访问）。后端仍不存账号密码。

```bash
# 一致快照（WAL 模式下安全，无需停服）
docker exec manifold-chat-demo node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/manifold.db').exec(\"VACUUM INTO '/data/backup-tmp.db'\")"
docker cp manifold-chat-demo:/data/backup-tmp.db ./manifold-$(date +%F).db
docker exec manifold-chat-demo rm -f /data/backup-tmp.db
# Phase 1 起还要备份图片二进制（blobs 目录与 DB 同卷，但 VACUUM INTO 不含它）：
docker cp manifold-chat-demo:/data/blobs ./blobs-$(date +%F)
```

`docker compose -f compose.edge.yml down` **不删卷**；加 `-v` 才会连对话一起删（不可逆）。

## Phase 1 迁移（老会话 → messages/blobs 表）

部署 Phase 1 代码后，把老的单 JSON-blob 会话（含内联 base64 图）迁移到新表（一次性、幂等、保留老 `data` 可回退）：

1. **先备份**（见上「数据与备份」，DB + blobs 目录都要）。
2. **跑迁移**：
   ```bash
   docker exec manifold-chat-demo node migrate-phase1.ts
   #   输出：迁移完成：会话 N（跳过已迁移 …）、消息 M、新 blob K
   ```
   幂等，可重复跑（已迁移的会话自动跳过）。
3. **抽查**：浏览器 **Ctrl+Shift+R 强刷**，登录后老会话应正常显示、图片走 `/api/blobs/:hash`（DevTools Network 里图片请求是 `/api/blobs/...` 而非 base64）。
4. **灰度稳定后下线旧 `/store`**：`compose.edge.yml` 的 environment 加 `LEGACY_STORE: "off"` → `up -d`，验证 `curl -sS https://chat.zstuacm.xyz/store/conversations` 返回 404。
5. 跑几天确认无误后，老 `conversations.data` 列可单独清空释放空间；在此之前**保留以便回退**。

## 注意事项

- **安全面**：身份/计费仍挂 sub2api（chat-demo 不存账号密码）。⚠ **0b 起 chat-demo 在 `sessions` 表存 sub2api 的 jwt/refresh 和选中的 API key**——DB 成秘密载体（见上「数据与备份」），换来 key 不再进浏览器（httpOnly cookie，XSS 偷不到）。面向公众的几道闸门已**内置**：
  - **按 IP 限流**：登录类（`/api/v1/auth/login*`）严格档挡撞密码，`/api /v1 /store` 通用档挡刷接口；超额回 `429 + Retry-After`。
    额度见 `.env.example`（`RL_*`）。⚠ **必须跑在反代后面**——真实客户端 IP 靠 Caddy 的 `X-Forwarded-For`
    还原（方式 A 的 Caddyfile 已配 `header_up`）；裸暴露端口时 XFF 可伪造，限流即失效。
  - **CSP + 安全头**：HTML 响应带严格 `Content-Security-Policy`（脚本/连接/样式全锁同源，无 `unsafe-inline`）
    + `X-Frame-Options`/`nosniff`/`Referrer-Policy`/`Permissions-Policy`，是模型输出 DOMPurify 之上的兜底。
  - **每账号存储配额**：单账号对话条数 / 总字节封顶（`STORE_MAX_*`，默认 500 条 / 200MB），防泄露凭证撑爆磁盘。
  - **cookie 鉴权 + CSRF**：登录态用 `HttpOnly; SameSite=Lax` cookie（生产经 https 自动带 `Secure`）；写操作校验同源头作 CSRF 兜底。凭证不进浏览器。
  - **仍需人工把关的一条**：注册必须保持**仅管理员开号**（sub2api 侧关闭自助注册）。一旦放开自助注册，
    陌生人即可烧 ChatGPT Plus / 生图额度——限流挡频率，挡不住"合法但滥用"的账号。
- **优雅关闭（重启不掐流）**：后端 0b 起持 session、转发在途 SSE 流，收到 SIGTERM 会先排空在途流 + 刷 WAL 再退。Docker 须给足宽限——compose 已配 `stop_grace_period: 35s`（配合 `SHUTDOWN_TIMEOUT_MS=30000`）；宽限太短会 SIGKILL 硬掐所有在途流。
- **生图进行中刷新页面**：生图是实时请求，刷新会**中断它且不可恢复**——提示词会留下、但不会有结果。这是预期行为。
- **生图与 CF 100 秒超时**：外层 浏览器→CF→Caddy→chat-demo 仍受 CF ~100 秒首字节限制。默认走流式生图
  （`stream: true`，逐事件 flush），首字节十几秒就到，正常不触发；若上游太老回退非流式、超 100 秒可能 524 ——
  升级 sub2api 或调低质量档位。
- **真实客户端 IP**：Caddy 用 `Cf-Connecting-Ip` 还原后经 `X-Forwarded-For` 传给 chat-demo，再透传 sub2api。

---

## 方式 B：独立部署（Cloudflare Tunnel，无现成反代时）

仓库自带的 `docker-compose.yml` 就是这套：`chat-demo` + `cloudflared`，自带网络，零入站端口、不用管证书。

1. 克隆仓库到服务器（任意路径）。
2. Cloudflare 面板 → Zero Trust → Networks → Tunnels → **Create a tunnel** → Cloudflared → 复制 `--token`
   后那串作为 `TUNNEL_TOKEN`；Public Hostname 填 `chat.zstuacm.xyz` → Service `HTTP` `chat-demo:8787`。
3. `cp .env.example .env`，填 `TUNNEL_TOKEN`；`SUB2API_BASE` 指向 sub2api（同机发布了宿主机端口则
   `http://host.docker.internal:8080`，否则把 chat-demo 加进 sub2api 的网络用容器名）。
4. `docker compose up -d --build`。

> ⚠ 本仓库公开：服务器 IP / token 只写在 `.env`（已 gitignore），别提交进仓库。

## 方式 C：不用 Docker（systemd）

服务器装 Node ≥ 22（需内置 `node:sqlite`），直接 systemd 跑：

```ini
# /etc/systemd/system/manifold-chat.service
[Unit]
Description=Manifold chat-demo
After=network.target

[Service]
Environment=SUB2API_BASE=http://127.0.0.1:8080
Environment=DB_PATH=/var/lib/manifold-chat/manifold.db
Environment=PORT=8787
ExecStart=/usr/bin/node /opt/manifold/chat-demo/server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now manifold-chat`，对外暴露仍需 Caddy 或 Tunnel。
