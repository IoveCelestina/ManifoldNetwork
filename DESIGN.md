# ManifoldNetwork 架构蓝图 · 从「套壳」到「真前后端」

> 本文是**施工蓝图**，不是已实现的现状。落地按文末「分阶段」推进，每阶段可独立停下。
> 现状（main 分支）仍是：浏览器持 key 直打 `/v1`、服务端是哑代理 + 单 JSON-blob 会话库。

## 0. 范围与已定决策

这一版**刻意不重**，但要求真正的前后端分离。已拍板：

| 维度 | 决策 |
|---|---|
| 推理调用 | **搬到服务端**（key/JWT 不再进浏览器） |
| 存储 | **后端拥有**，仍用 SQLite + 卷里 blob 文件 |
| 身份/计费 | **继续挂 sub2api**（后端验 token，沿用邀请制） |
| 前端 | 暂**不重写**，把现有 vanilla UI 从「大脑」瘦成「瘦客户端」，重指向后端 API |
| 文件处理 | **先不做**（Phase 2 再说） |
| 不做（非目标） | Postgres、消息队列、RAG/向量库、代码解释器、自有账号体系、多租户计费 |

## 1. 拓扑

### 1.1 部署拓扑（物理几乎不变）
```
浏览器 ──HTTPS chat.zstuacm.xyz──▶ Cloudflare(代理, ~100s 首字节限)
                                      ▼
                                 manifold-caddy(终结 TLS · XFF 还原)
                                      │ reverse_proxy [manifold-edge]
                                      ▼
                       manifold-chat-demo:8787  ← 后端（哑代理 → 应用服务器）
                         ├─ SQLite  /data/manifold.db   sessions / conversations / messages
                         └─ Blob FS /data/blobs/<hash>  图·文件二进制（同一命名卷）
                                      │ 服务端调用 [manifold-edge]，凭证不出服务器
                                      ▼
                       manifold-sub2api:8080   身份 / 计费 / 推理（chat · vision · image）
```
网络、端口、卷、Caddy 配置全照旧；仅在卷里新增 `blobs/` 目录。

### 1.2 逻辑拓扑（一次聊天）
```
[瘦客户端]                     [应用后端 = 大脑]                    [上游 sub2api]
输入 ─POST /api/conversations/:id/messages─▶ 鉴权(cookie→session)
                                            ├ 落库 user 消息（1 行）
                                            ├ 组装上下文（系统提示 + 历史 + 图 image_url）
                                            └ 用 session.api_key 服务端调 ─▶ /v1/chat/completions
渲染流式 ◀──────── SSE 转发 token ──────────┘ ◀──────────────────────────── 上游 SSE
                                            末尾落库 assistant 消息（1 行）
```
key / JWT 全程只在后端 session；浏览器仅持一个 httpOnly cookie。

### 1.3 数据拓扑
```
SQLite(/data/manifold.db, WAL)
  sessions ─uid─┐
  conversations ┼─ uid 隔离
  messages ─────┘ (conv_id, seq) ─ message_blobs ─▶ blobs(hash) ─▶ /data/blobs/<hash>
```

## 2. 鉴权 / 会话（身份仍走 sub2api）

浏览器不再持 token/key，改为后端服务端会话 + httpOnly cookie。

**登录流**
1. `POST /api/session/login {email, password}` → 后端调 sub2api `POST /api/v1/auth/login`。
2. 若上游要 2FA → 后端返回 `{need_2fa:true, ticket}`；浏览器 `POST /api/session/2fa {ticket, code}` → 后端调 `/api/v1/auth/login/2fa`。
3. 成功后后端拿到 `{access_token, refresh_token}`，调 `/api/v1/auth/me` 取 `uid`，调 `/api/v1/keys?page=1&page_size=100` 取该用户的 key（默认选唯一/首个，或让用户 `POST /api/keys/select`）。
4. 写一行 `sessions`，给浏览器种 **httpOnly · Secure · SameSite=Lax** cookie（值 = `sessions.token`）。

**令牌刷新**：后端用 session 调上游遇 401 → 用 `refresh` 调 `/api/v1/auth/refresh`，更新 session（移植现 `tryRefresh` 逻辑到服务端，含「并发 401 共享一次刷新」防风暴）。
**登出**：`POST /api/session/logout` → 删 session 行 + 清 cookie（顺带可调上游 `/api/v1/auth/logout`）。
**免登录贴 key 模式**（待定，见 §9）：浏览器把 `sk-` POST 给后端 → 后端建一个仅含 `api_key` 的临时 session。key 仍离开浏览器但只到同源后端。

## 3. 数据模型（SQLite DDL 草案）

```sql
-- 服务端会话：token/key 只活在这里
CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,        -- 随机 256-bit，cookie 值
  uid         INTEGER NOT NULL,        -- sub2api user_id（贴 key 模式可为 NULL）
  jwt         TEXT,                    -- sub2api access_token
  refresh     TEXT,                    -- sub2api refresh_token
  api_key     TEXT,                    -- 选中的 sk- key（服务端代取/暂存）
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_uid ON sessions(uid);

-- 会话元数据（不含正文）
CREATE TABLE conversations (
  uid         INTEGER NOT NULL,
  id          TEXT    NOT NULL,        -- c_xxx
  title       TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (uid, id)
);
CREATE INDEX idx_conv_uid_updated ON conversations(uid, updated_at DESC);

-- 一条消息一行：每轮只 INSERT，不再重写整段会话
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,        -- m_xxx
  conv_id     TEXT    NOT NULL,
  uid         INTEGER NOT NULL,        -- 冗余便于按用户配额/清理
  seq         INTEGER NOT NULL,        -- 会话内顺序
  role        TEXT    NOT NULL,        -- user | assistant
  kind        TEXT    NOT NULL,        -- chat | image | error
  model       TEXT,
  text        TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_msg_conv_seq ON messages(conv_id, seq);

-- 二进制实体：内容哈希唯一，bytes 落 /data/blobs/<hash>
CREATE TABLE blobs (
  hash        TEXT PRIMARY KEY,        -- sha256(hex)
  mime        TEXT    NOT NULL,
  size        INTEGER NOT NULL,        -- 字节
  created_at  INTEGER NOT NULL
);

-- 消息 ↔ blob（一条消息可挂多张图/文件）
CREATE TABLE message_blobs (
  message_id  TEXT    NOT NULL,
  blob_hash   TEXT    NOT NULL,
  ord         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, blob_hash)
);
CREATE INDEX idx_mb_hash ON message_blobs(blob_hash);
```

**配额**（沿用本能力，口径升级）：每用户 = Σ(该 uid 消息 text 字节) + Σ(被其消息引用的 blob.size，按 hash 去重)。
**Blob GC**：`blobs` 无任何 `message_blobs` 引用即孤儿，可定期清（删行 + 删文件）。
**Blob 鉴权**：`GET /api/blobs/:hash` 必须校验当前 session.uid 拥有引用该 hash 的消息，否则 404。

## 4. 后端 API 面

```
鉴权
  POST /api/session/login        {email,password} → {ok} | {need_2fa,ticket} ; Set-Cookie
  POST /api/session/2fa          {ticket,code}    → {ok} ; Set-Cookie
  POST /api/session/logout       → {ok} ; 清 cookie
  GET  /api/session/me           → {email, uid, key:{label,platform}}（不含 key 明文）
  GET  /api/keys                 → [{id,label,platform,masked}]
  POST /api/keys/select          {id} → {ok}

会话
  GET    /api/conversations              → [{id,title,createdAt,updatedAt}]
  POST   /api/conversations              {title?} → {id,...}
  GET    /api/conversations/:id          → {id,title,...,messages:[{id,role,kind,model,text,blobs:[hash]}]}
  PATCH  /api/conversations/:id          {title} → {ok}
  DELETE /api/conversations/:id          → {ok}

聊天 / 生图（服务端调上游）
  POST /api/conversations/:id/messages   {text, attachments:[hash]} → SSE 流（token / 完成事件）
  POST /api/conversations/:id/images     {prompt,size,quality, refs:[hash]} → SSE 或 {message}
  GET  /api/models                       → 透传上游 /v1/models（用于模型选择器）

附件 / 二进制
  POST /api/blobs                        (multipart 或 raw) → {hash,mime,size}（已去重则直接返回）
  GET  /api/blobs/:hash                  → bytes（鉴权 + 强缓存 immutable，因内容寻址）
```
> 现有 `/store/*`、浏览器直打 `/v1/*` / `/api/v1/*` 的同源代理在迁移期保留，Phase 0 完成后下线。

## 5. 流式（SSE）

- 后端读上游 SSE → 可改写/分段 → 转发给浏览器；流结束后把整段 assistant 文本落 `messages`。
- **中断**：浏览器断开 → 后端 `AbortController` 掐上游（移植现有逻辑）；中断时落已收到的部分文本 + 标记 `kind` 以便前端提示。
- **CF 100s**：默认流式（首字节十几秒到）规避；非流式回退仍可能 524（同现状）。
- 背压：沿用现有 `res.write` + drain 处理。

## 6. 推理编排（后端组装上下文）

- 系统提示移到**后端**（前端再也看不到/改不了）。
- 历史拼装：取该会话 `messages` 按 `seq`；图片消息把引用的 blob 读出 → 以 `image_url`（base64 或 data URL）拼进 `content` parts（与现 `/v1/chat/completions` 入参一致）。
- 窗口控制：超长历史按策略截断/摘要（先简单截断，留 TODO）。
- 生图：模型为 `gpt-image-2` 时走 `/v1/images/generations`；带参考图走 `/v1/images/edits`（multipart，从 blob 还原文件）。生成结果存 blob，落一条 `kind=image` 消息。**先同步**，长耗时进队列是 Phase 2+ 的事。

## 7. 迁移（老会话 → 新模型）

现状：`conversations.data` 是 `{messages:[{role,text,images:[dataUrl],kind,model}]}`，图为内联 base64。

迁移脚本思路（一次性，跑前先备份；保留旧表直到验证通过）：
```
for 每个旧 conversations 行:
  解析 data.messages
  写 conversations 元数据行
  for 每条 message (按序 seq++):
     for 每个 images[] 的 dataUrl:
        b64 解码 → sha256 → 若 /data/blobs/<hash> 不存在则写入 + INSERT blobs
        INSERT message_blobs(message_id, hash, ord)
     INSERT messages(id, conv_id, uid, seq, role, kind, model, text)
```
**惰性兼容**（可选）：首次 `GET` 某未迁移会话时即时迁移它，避免大停机。

## 8. 安全

- **后端从此有状态、在关键路径**：必须做 **SIGTERM 优雅关闭**（排空在途流、刷 WAL），否则重启掐断所有流。
- **DB 成了秘密载体**：`sessions` 含 jwt/refresh/key。DB 文件在 Docker 卷里，权限收紧；备份产物也含秘密，需同等保护。
- **key 保管方转移**：浏览器 → 服务端，总体更安全（XSS 偷不到 httpOnly cookie），但你成了 custodian。
- 既有 P0 闸门**继续生效**：按 IP 限流、CSP/安全头、每账号配额（口径见 §3）。
- cookie：`HttpOnly; Secure; SameSite=Lax; Path=/`；CSRF 面因 SameSite=Lax + 仅同源 API 而很小，写操作仍建议校验来源/自定义头。

## 9. 待确认 / TODO

1. **上游 `/v1` 认什么凭证**：`sk-` key 还是也认 JWT？认 JWT 则 §2 可省「代取 key」一步。实现时一测便知。
2. **免登录贴 key 模式**是否保留（§2）。建议保留，作为临时 session。
3. **session 存哪**：SQLite 表（重启不掉线，推荐）还是内存（重启需重登）。
4. **窗口截断策略**：先简单截断，后续可加摘要。
5. **前端何时上框架**：UI 复杂度顶上来再上 React/Svelte；Phase 0/1 仍用现 vanilla。

## 10. 分阶段

- **Phase 0 ｜ 真后端 + 服务端推理**（壳 → 产品的那一跃）
  - 加 `sessions` + httpOnly cookie 鉴权；登录/2FA/刷新/登出移服务端。
  - `/api/conversations/:id/messages`、`/images`、`/models` 服务端调上游 + SSE。
  - 前端重指向这些 API，删除客户端持 key / 拼 prompt。
  - **存储先沿用现 blob 模型**（最小风险）。下线浏览器直打 `/v1`。
- **Phase 1 ｜ 拆数据模型**
  - 建 `conversations/messages/blobs/message_blobs`，加 `/api/blobs`。
  - 跑 §7 迁移；图片改 `<img src="/api/blobs/:hash">`，base64 不再进 JSON。
  - 治掉「每轮重写整段」与存储膨胀。
- **Phase 2 ｜ 文件处理（可缓）**
  - 前端/后端抽文本进上下文（txt/代码/csv/json → PDF→pdf.js → Office）。
  - RAG/向量库：仅当确有「与长文档对话」需求时再评估，非默认。
```
