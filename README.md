# ManifoldNetwork · 对话与生图工作台

一个**相对独立**的聊天 + 图片生成工作台，不改 sub2api 任何东西：

```
浏览器 ──同源──> 本服务(server.js)
                   ├─ /            静态前端（登录 / 聊天 / 生图）
                   ├─ /store/*     会话存储（SQLite，按 sub2api 账号隔离）
                   ├─ /api/v1/*  ──转发──> sub2api 用户接口（登录、key 列表）
                   └─ /v1/*      ──转发──> sub2api 网关（聊天、识图、生图）
```

浏览器只跟本服务同源通信，所以 **sub2api 不需要改 CORS**。

> 部署到服务器（与 sub2api 完全分开）→ 见 [DEPLOY.md](DEPLOY.md)

## 跑起来

```powershell
cd ManifoldNetwork
node server.js                       # 默认上游 https://zstuacm.xyz，端口 8787
```

自定义：

```powershell
$env:SUB2API_BASE = "https://zstuacm.xyz"; $env:PORT = "8787"; node server.js
```

打开 http://localhost:8787

## 功能

| 功能 | 说明 |
|---|---|
| 登录 | 复用 sub2api 账户密码（`POST /api/v1/auth/login`），支持 TOTP 两步验证 |
| Key | 登录后自动列出账户 key（只有一把时自动选用）；也可不登录直接粘贴 key |
| 聊天 | `POST /v1/chat/completions`，SSE 流式，Markdown 渲染 |
| 识图 | 上传图片（自动压到最长边 1568px），以 `image_url` base64 随消息发送 |
| 生图 | 模型切到 `gpt-image-2`（输入区变琥珀色）→ 描述画面 → `POST /v1/images/generations` |
| 垫图改图 | 生图模式下附参考图 + 描述 → 自动改走 `POST /v1/images/edits`（multipart） |
| 会话 | 登录账号 → 对话存服务端 SQLite、**跨设备按账号同步**；仅贴 key（不登录）→ 存浏览器 IndexedDB |

## 前提（重要）

v1 只接 **openai 平台**的 key（一把 key 同时覆盖聊天 + 识图 + 生图）：

1. sub2api 管理后台需要有 **openai 平台的分组**，分组下挂着可用的
   **ChatGPT Plus/Pro（Codex OAuth）账号**。
2. 生图模型是 `gpt-image-2`，要求 sub2api 为较新版本
   （带 `/v1/images/generations` 和 `/v1/images/edits` 端点；旧版本会 404）。
3. 用 anthropic 平台分组的 key 时聊天可用（自动转换），但生图会 404 ——
   sub2api 的 `/v1/images/*` 只对 openai 平台分组开放。

## 冒烟测试

不开浏览器先验证通路（消耗一次生图额度）：

```powershell
# 1. 起服务后，验证代理 + 上游连通（预期返回 401，因为没带 key）
curl http://localhost:8787/v1/models

# 2. 验证生图端到端（换成你的 key）
curl -X POST http://localhost:8787/v1/images/generations `
  -H "Authorization: Bearer sk-你的key" -H "Content-Type: application/json" `
  -d '{\"model\":\"gpt-image-2\",\"prompt\":\"a cute cat\",\"size\":\"1024x1024\"}'
```

若第 2 步返回 404：通常是线上 sub2api 版本还没有 `/v1/images/*` 端点（升级镜像即可），
或 key 所在分组平台不是 openai。

## 已知边界

- **对外服务的几道闸门已内置**：按 IP 限流（登录防爆破 + 接口防刷）、严格 CSP + 安全头、每账号存储配额。
  前提是**跑在反代后面**（真实 IP 靠 `X-Forwarded-For`）且**注册保持仅管理员开号**。细节与可调项见 [DEPLOY.md](DEPLOY.md)「注意事项」。
- 上游账号若开启 Cloudflare Turnstile 人机验证，登录接口会要求 `turnstile_token`，
  本 demo 未集成 Turnstile 小组件（自用一般不开）。
- 普通聊天模型（gpt-5.x）走文本通道，**永远不会出图**——出图必须切 `gpt-image-2`。
  已给聊天加系统提示，模型会主动提醒用户切换。
- 生成图片以 base64 存在浏览器 IndexedDB，清浏览器数据会丢；要长期保留请点「下载」。
