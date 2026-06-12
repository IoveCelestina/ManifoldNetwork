# ManifoldNetwork 服务器部署（与 sub2api 完全分开）

目标形态：

```
浏览器 ──HTTPS──> Cloudflare (chat.zstuacm.xyz)
                      │  Cloudflare Tunnel（出站连接，不开任何入站端口）
                      ▼
                 cloudflared 容器 ──内部网络──> chat-demo 容器
                                                    │  http://host.docker.internal:8080
                                                    ▼
                                               同机 sub2api（零改动）
```

**为什么选 Cloudflare Tunnel 方案：**

- **跟 sub2api 零耦合**：不动它的容器、配置、Caddy/端口，独立 compose 独立网络（对话数据在自己的命名卷里，要连数据一起删用 `docker compose down -v`）
- **不占 80/443**：cloudflared 是出站连接，服务器不用为它开任何入站端口，ufw 都不用动
- **不用管证书**：HTTPS 由 Cloudflare 边缘终结，源站不需要签证书
- **天然隐藏 IP + 国内可访问**：和主域名同一套 Cloudflare 体系（你的源站 IP 本来就被 GFW 封了 443，隧道方案正好完全不暴露源站）
- chat-demo → sub2api 走**机器内部**，不绕公网

---

## 前置确认（1 分钟）

SSH 到服务器，确认 sub2api 在宿主机的哪个地址监听：

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep -i sub2api
# 期望看到类似 127.0.0.1:8080->8080/tcp —— 记下这个端口
```

- 看到 `127.0.0.1:8080->8080` → `SUB2API_BASE=http://host.docker.internal:8080`（默认值，不用改）
- 端口不是 8080 → 改 `.env` 里的端口号
- sub2api 没有发布宿主机端口（只在某个 docker 网络里）→ 最省事：给它的 compose 加一行
  `ports: ["127.0.0.1:8080:8080"]` 重启；或者把 chat-demo 容器加进 sub2api 所在的 docker 网络，
  `SUB2API_BASE=http://<sub2api容器名>:8080`（这算轻微耦合，二选一看你接受度）

## 第 1 步：上传文件

服务器上直接克隆仓库（推荐，之后更新只要 `git pull`）：

```bash
git clone https://github.com/IoveCelestina/ManifoldNetwork.git /root/ManifoldNetwork
```

或从本机（Windows PowerShell）scp 拷过去：

```powershell
scp -r C:\Users\ht\Desktop\ManifoldNetwork root@<服务器IP>:/root/ManifoldNetwork
```

> 不需要 node_modules（项目零依赖）。
> ⚠ 本仓库是公开的：服务器 IP 只写在本机/服务器，别提交进仓库。

## 第 2 步：Cloudflare 面板建隧道（点 5 下）

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → **Zero Trust** → **Networks** → **Tunnels**
2. **Create a tunnel** → 选 **Cloudflared** → 名字填 `manifold-chat` → Save
3. 安装方式随便选一个（Docker），**复制命令里 `--token` 后面那一长串** —— 这就是 `TUNNEL_TOKEN`
4. 下一步 **Public Hostnames** → **Add a public hostname**：
   - Subdomain: `chat`，Domain: `zstuacm.xyz`
   - Service: Type `HTTP`，URL `chat-demo:8787`（compose 内部服务名，照填）
5. Save。CF 会自动在 DNS 里建好 `chat.zstuacm.xyz` 的 CNAME（橙云代理）

## 第 3 步：启动

服务器上：

```bash
cd /root/ManifoldNetwork
cp .env.example .env
vi .env          # 填 TUNNEL_TOKEN=<第2步复制的token>；SUB2API_BASE 按前置确认改
docker compose up -d --build
```

## 第 4 步：验证

```bash
# 容器都活着（chat-demo 应为 healthy，cloudflared 应为 Up）
docker compose ps

# 代理链路通（在服务器上测容器 → sub2api）
docker compose exec chat-demo wget -qO- http://localhost:8787/v1/models ; echo
# 预期输出 API key required 的 401 JSON —— 这就是通了

# 公网链路通
curl -s -o /dev/null -w '%{http_code}\n' https://chat.zstuacm.xyz/
# 预期 200
```

浏览器开 `https://chat.zstuacm.xyz`，登录/粘 key 走起。

---

## 日常运维

| 操作 | 命令 |
|---|---|
| 看日志（含生图诊断） | `docker compose logs -f chat-demo` |
| 更新代码 | 本机改完 → 重新 `scp -r` 覆盖 → 服务器 `docker compose up -d --build` |
| 重启 | `docker compose restart` |
| 整套下线 | `docker compose down`（卸载隧道再去 CF 面板删 tunnel + DNS 记录） |
| 备份 | 备份 `manifold-chat-data` 卷里的 `manifold.db`（见下方「数据与备份」）；登录态仍在用户浏览器 |

## 数据与备份

升级到「按账号同步对话」后，**服务端不再是零状态**：对话存在 chat-demo 容器内的 SQLite
（`DB_PATH=/data/manifold.db`，落在命名卷 `manifold-chat-data`）。身份与计费仍走 sub2api，
后端不存密码、不存 key，只按 sub2api 的 `user_id` 隔离存对话。

```bash
# 一致快照（WAL 模式下安全，无需停服）
docker compose exec chat-demo node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('/data/manifold.db').exec(\"VACUUM INTO '/data/backup-tmp.db'\")"
docker compose cp chat-demo:/data/backup-tmp.db ./manifold-$(date +%F).db
docker compose exec chat-demo rm -f /data/backup-tmp.db
```

- `docker compose down` **不删卷**，数据还在；`docker compose down -v` 会**连对话一起删**（不可逆）。
- 公网开放给陌生人前，仍需补**每 IP 限流 / 登录防爆破 / CSP** 等公开级防护（当前定位为自用/熟人）。

## 注意事项

- **生图与 Cloudflare 100 秒超时**：浏览器 → CF → chat-demo 这条外层链路仍受 CF 100 秒首字节限制。
  demo 已默认用流式生图（`stream: true`，sub2api 会逐事件 flush），首字节十几秒就到，正常不会触发。
  如果某次走了非流式回退（上游版本太老不认 `stream`），超过 100 秒仍可能 524 —— 解法是升级 sub2api 或调低质量档位。
- **安全面**：chat-demo 自己不做鉴权，它只是 sub2api 的同源转发器——鉴权、限流、计费全由
  sub2api 的账号体系和 API key 把关，和用户直接调 sub2api 是同一个信任模型。
  真实客户端 IP 已通过 `X-Forwarded-For` 透传给 sub2api（CF → cloudflared 这层会带上）。
- **镜像版本**：`cloudflared:latest` 是滚动 tag。要锁版本的话照你 deploy/ 的习惯
  `docker inspect --format '{{index .RepoDigests 0}}' cloudflare/cloudflared:latest` 拿 digest 钉死。
- **想换路径形态**（`zstuacm.xyz/chat` 而不是子域名）：那就必须在现有边缘（终结 zstuacm.xyz 的那层）
  加路由，做不到和 sub2api 部署完全分开 —— 所以推荐子域名。

## 备选方案（不想用 Tunnel 时）

**B. 源站已有 Caddy 终结 TLS**：chat-demo 容器发布 `127.0.0.1:8787:8787`，Caddyfile 加：

```caddy
chat.zstuacm.xyz {
    reverse_proxy 127.0.0.1:8787
}
```

CF 面板 DNS 加 `chat` 的 A 记录（橙云）指向源站。代价：动了公共 Caddy（轻微耦合）。

**C. 不用 Docker**：服务器装 Node ≥ 18 后直接 systemd 跑：

```ini
# /etc/systemd/system/manifold-chat.service
[Unit]
Description=Manifold chat-demo
After=network.target

[Service]
Environment=SUB2API_BASE=http://127.0.0.1:8080
Environment=PORT=8787
ExecStart=/usr/bin/node /root/ManifoldNetwork/server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now manifold-chat`，对外暴露仍需 Tunnel 或 Caddy 二选一。
