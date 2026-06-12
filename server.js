// Manifold chat-demo 服务器：静态文件 + 同源反向代理。
//
// 浏览器永远只跟本服务同源通信，/api/v1/*（登录、key 管理）和 /v1/*（推理、生图）
// 原样转发到 SUB2API_BASE —— 这样不需要 sub2api 改任何 CORS 配置。
//
// 用法：
//   node server.js
//   SUB2API_BASE=https://zstuacm.xyz PORT=8787 node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const BASE = (process.env.SUB2API_BASE || 'https://zstuacm.xyz').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'public');

// ── 会话存储（/store/*，按 sub2api user_id 隔离）──────────────────
const db = require('./db');                  // node:sqlite 单文件
const STORE_MAX_BODY = 100 * 1024 * 1024;    // /store 单条对话写入上限，防 DB 撑肿
const USER_CACHE_TTL = 60 * 1000;            // token→user_id 解析缓存 TTL
const CONV_ID_RE = /^[A-Za-z0-9_-]{1,128}$/; // 合法会话 id（与前端 c_xxx 命名一致）
const userCache = new Map();                 // token -> { uid, exp }

// ── 按 IP 限流（令牌桶）─────────────────────────────────────────
// 本服务设计为只跑在反代（Caddy）后面：真实客户端 IP 由 Caddy 经 X-Forwarded-For 透传进来
// （见 FORWARD_REQ_HEADERS / DEPLOY.md 的 header_up）。⚠ 直接裸暴露到公网时 XFF 可伪造，限流即失效。
//   auth 档    —— 只盖 /api/v1/auth/login*，挡登录暴力撞密码（窗口内允许 burst 次尝试）
//   general 档 —— 盖 /api /v1 /store，挡刷接口 / 爬；静态资源不计（页面加载本就要拉好几个文件）
// 每档 burst 个令牌、windowSec 内匀速回满，超额回 429 + Retry-After。RATE_LIMIT=off 可整体关闭（本地调试用）。
const RL_ENABLED = (process.env.RATE_LIMIT || 'on').toLowerCase() !== 'off';
const RL_TIERS = {
  auth: {
    burst: Number(process.env.RL_AUTH_BURST || 20),
    windowSec: Number(process.env.RL_AUTH_WINDOW || 600),
  },
  general: {
    burst: Number(process.env.RL_GENERAL_BURST || 120),
    windowSec: Number(process.env.RL_GENERAL_WINDOW || 60),
  },
};
const rlBuckets = new Map();                  // `${tier}:${ip}` -> { tokens, last }

function rlTierFor(url) {
  if (url.startsWith('/api/v1/auth/login')) return 'auth'; // 含 /login 与 /login/2fa
  if (url.startsWith('/api/') || url.startsWith('/v1/') || url.startsWith('/store/')) return 'general';
  return null;                                // 静态资源：不限流
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();   // 最左 = 原始客户端（Caddy 只塞一个值）
  return req.socket?.remoteAddress || 'unknown';
}

// 取一个令牌：允许则 {ok:true}，否则 {ok:false, retryAfter}（秒）。
function rlTake(tier, ip, now) {
  const cfg = RL_TIERS[tier];
  const refillPerSec = cfg.burst / cfg.windowSec;
  const key = `${tier}:${ip}`;
  let b = rlBuckets.get(key);
  if (!b) { b = { tokens: cfg.burst, last: now }; rlBuckets.set(key, b); }
  b.tokens = Math.min(cfg.burst, b.tokens + ((now - b.last) / 1000) * refillPerSec);
  b.last = now;
  if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
  return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec)) };
}

// 限流闸门：被挡则就地回 429 并返回 true（调用方应直接 return）。
function rateLimited(req, res) {
  if (!RL_ENABLED) return false;
  const tier = rlTierFor(req.url);
  if (!tier) return false;
  const r = rlTake(tier, clientIp(req), Date.now());
  if (r.ok) return false;
  res.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After': String(r.retryAfter),
    'Connection': 'close',
  });
  res.end(JSON.stringify({ error: { message: `请求过于频繁，请约 ${r.retryAfter}s 后再试`, type: 'rate_limited' } }));
  return true;
}

// 定期清掉久未访问的桶（这些桶早已回满，无状态可丢），避免 Map 随 IP 数无限增长。
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, b] of rlBuckets) if (b.last < cutoff) rlBuckets.delete(k);
}, 10 * 60 * 1000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

// CSP：DOMPurify（app.js 渲染模型 Markdown 时）之上的兜底——脚本/连接/样式全锁同源，
// 杜绝任何外链或内联注入。本应用纯同源 + 本地 vendor 脚本，故无需 'unsafe-inline'/'unsafe-eval'。
// data:/blob: 仅放给 img（生成图 base64、上传图 blob、背景与 favicon 的 data: SVG）。
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
].join('; ');

// 静态响应通用安全头（nosniff 等）。Caddy 也会加一部分，这里再设一遍，让非 Caddy 部署（systemd/裸跑）同样受保护。
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

// 只透传这些请求头；host/origin/cookie 等一律不带，避免上游产生奇怪行为
// x-forwarded-for / x-real-ip：部署在服务器上时把真实客户端 IP 透传给 sub2api（限流/审计用）
const FORWARD_REQ_HEADERS = [
  'content-type',
  'authorization',
  'x-api-key',
  'accept',
  'accept-language',
  'x-forwarded-for',
  'x-real-ip',
];

// 这些响应头不能照抄：fetch 已解压、长度和编码由本服务重新决定
const SKIP_RES_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
]);

const MAX_BODY = 100 * 1024 * 1024; // 单请求体上限；防恶意大包打爆内存（识图 base64 一般远用不到）

function collectBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(Object.assign(new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxy(req, res) {
  const started = Date.now();
  const target = BASE + req.url;
  const headers = {};
  for (const h of FORWARD_REQ_HEADERS) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }
  // 保持流式响应简单：让上游别压缩
  headers['accept-encoding'] = 'identity';

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await collectBody(req);
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8', 'Connection': 'close' });
      res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
      return;
    }
    if (body.length === 0) body = undefined;
  }

  // 客户端中途断开时同步掐断上游请求，避免空转
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(new Error('上游超时')), 10 * 60 * 1000); // 生图可能要跑几分钟
  res.on('close', () => {
    if (!res.writableEnded) ctrl.abort(new Error('客户端断开'));
  });

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const ms = Date.now() - started;
    console.error(`[proxy] ${req.method} ${req.url} -> FAIL ${err.message} (${ms}ms)`);
    if (!res.writableEnded) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Connection': 'close' });
      res.end(JSON.stringify({
        error: { message: `代理到上游失败: ${err.message}`, type: 'proxy_error', upstream: BASE },
      }));
    }
    return;
  }

  const resHeaders = {};
  upstream.headers.forEach((v, k) => {
    if (!SKIP_RES_HEADERS.has(k.toLowerCase())) resHeaders[k] = v;
  });
  res.writeHead(upstream.status, resHeaders);

  // 生图链路诊断：记录响应头尾片段，定位截断/格式问题
  const diag = req.url.startsWith('/v1/images/');
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let total = 0;
  let truncatedBy = '';

  if (upstream.body) {
    res.flushHeaders();
    try {
      for await (const chunk of Readable.fromWeb(upstream.body)) {
        total += chunk.length;
        if (diag) {
          if (head.length < 160) head = Buffer.concat([head, chunk]).subarray(0, 160);
          tail = Buffer.concat([tail, chunk]).subarray(-160);
        }
        if (res.destroyed) { truncatedBy = 'client-destroyed'; break; }
        // 背压：客户端消费慢时停一拍，否则长流式会把内存写爆
        if (!res.write(chunk)) {
          const drained = await new Promise((resolve) => {
            const onDrain = () => { cleanup(); resolve(true); };
            const onClose = () => { cleanup(); resolve(false); };
            const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); };
            res.once('drain', onDrain);
            res.once('close', onClose);
          });
          if (!drained) { truncatedBy = 'client-closed'; break; }
        }
      }
    } catch (err) {
      truncatedBy = `upstream: ${err.message}`;
      console.error(`[proxy] ${req.method} ${req.url} stream interrupted: ${err.message}`);
    }
  }
  clearTimeout(timeout);
  res.end();
  console.log(`[proxy] ${req.method} ${req.url} -> ${upstream.status} (${Date.now() - started}ms)`);
  if (diag) {
    console.log(`[diag] ${req.url} status=${upstream.status} type=${upstream.headers.get('content-type')} bytes=${total} truncated=${truncatedBy || 'no'}`);
    console.log(`[diag] head: ${head.toString('utf8').replace(/\n/g, '\\n')}`);
    console.log(`[diag] tail: ${tail.toString('utf8').replace(/\n/g, '\\n')}`);
  }
}

function parseBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function sendJson(res, status, obj) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// token → sub2api user_id。带 60s 缓存，避免每个 /store 请求都回调 /api/v1/auth/me。
// 客户端无法伪造身份：uid 来自上游对 token 的验证，不信任客户端自报。
async function resolveUser(token) {
  if (!token) return null;
  const now = Date.now();
  const hit = userCache.get(token);
  if (hit && hit.exp > now) return hit.uid;

  let uid = null;
  try {
    const r = await fetch(BASE + '/api/v1/auth/me', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });
    if (r.ok) {
      const j = await r.json();
      const data = (j && typeof j === 'object' && 'data' in j) ? j.data : j; // 兼容 {code,message,data} 信封
      const raw = data?.id ?? data?.user_id ?? data?.user?.id;
      if (raw !== undefined && raw !== null && Number.isFinite(Number(raw))) uid = Number(raw);
    }
  } catch { /* 上游不可达 → 视为未认证 */ }

  if (uid !== null) {
    userCache.set(token, { uid, exp: now + USER_CACHE_TTL });
    if (userCache.size > 1000) {                  // 简单防膨胀：清掉过期项
      for (const [k, v] of userCache) if (v.exp <= now) userCache.delete(k);
    }
  }
  return uid;
}

// /store/conversations          GET   列表（仅元数据）
// /store/conversations/<id>     GET   单条（含 messages） / PUT 写入 / DELETE 删除
async function handleStore(req, res) {
  const uid = await resolveUser(parseBearer(req));
  if (uid === null) { sendJson(res, 401, { error: { message: '未登录或登录已过期' } }); return; }

  const segs = req.url.split('?')[0].split('/').filter(Boolean); // ['store','conversations', id?]
  if (segs[1] !== 'conversations') { sendJson(res, 404, { error: { message: 'not found' } }); return; }
  const convId = segs[2] || null;
  if (convId && !CONV_ID_RE.test(convId)) { sendJson(res, 400, { error: { message: '非法会话 id' } }); return; }

  // 集合
  if (!convId) {
    if (req.method === 'GET') { sendJson(res, 200, { conversations: db.listMeta(uid) }); return; }
    sendJson(res, 405, { error: { message: 'method not allowed' } });
    return;
  }

  // 单条
  if (req.method === 'GET') {
    const conv = db.getOne(uid, convId);
    if (!conv) { sendJson(res, 404, { error: { message: 'not found' } }); return; }
    sendJson(res, 200, conv);
    return;
  }
  if (req.method === 'DELETE') {
    db.del(uid, convId);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'PUT') {
    let body;
    try { body = await collectBody(req, STORE_MAX_BODY); }
    catch (err) { sendJson(res, err.statusCode || 400, { error: { message: err.message } }); return; }
    let conv;
    try { conv = JSON.parse(body.toString('utf8')); }
    catch { sendJson(res, 400, { error: { message: 'body 不是合法 JSON' } }); return; }
    if (!conv || conv.id !== convId) { sendJson(res, 400, { error: { message: 'body.id 与路径不一致' } }); return; }
    const result = db.upsert(uid, conv);
    if (!result.ok) {                            // 超配额：413 + 中文提示，前端 persistConv 会 alert 给用户
      const msg = result.code === 'quota_conversations'
        ? `保存失败：对话数量已达账号上限（${result.limit} 条），请删除一些旧对话后重试`
        : `保存失败：账号存储已达上限（${Math.round(result.limit / 1024 / 1024)}MB），请删掉旧对话或含图对话后重试`;
      sendJson(res, 413, { error: { message: msg, type: result.code } });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 405, { error: { message: 'method not allowed' } });
}

function serveStatic(req, res) {
  // 畸形百分号编码（如 /%、/%ZZ）会让 decodeURIComponent 抛 URIError；必须就地拦成 400。
  // 否则该同步异常会冒泡出 createServer 回调、无人接管 → 进程崩溃（一行 curl 即可远程 DoS）。
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  if (urlPath === '/config.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(`window.__CHAT_CONFIG__ = ${JSON.stringify({ upstream: BASE })};`);
    return;
  }

  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    };
    if (ext === '.html') {                       // CSP / 防嵌套只对承载脚本的 HTML 文档有意义
      headers['Content-Security-Policy'] = CSP;
      headers['X-Frame-Options'] = 'DENY';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  // 兜底：任何同步异常都不该掀翻进程。proxy() 是异步、自带 .catch；serveStatic() 是同步，
  // 这里再包一层，把请求级错误关进 500，而不是让它变成 uncaughtException。
  try {
    if (rateLimited(req, res)) return;   // 限流闸门：挡在所有路由之前，洪峰打不到代理/库
    if (req.url.startsWith('/store/')) {
      handleStore(req, res).catch((err) => {
        console.error('[store] unhandled:', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end();
      });
    } else if (req.url.startsWith('/api/') || req.url.startsWith('/v1/')) {
      proxy(req, res).catch((err) => {
        console.error('[proxy] unhandled:', err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    } else {
      serveStatic(req, res);
    }
  } catch (err) {
    console.error('[request] unhandled:', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end();
  }
});

// 生图 / 长流式响应都可能远超默认超时
server.requestTimeout = 0;
server.headersTimeout = 60 * 1000;

// 最后一道兜底：未预料到的异常 / Promise 拒绝只记录，不让进程无声退出。
// 已知崩溃向量（畸形 URL）已在请求层就地拦成 400/500，这里只为留住诊断线索，
// 避免线上「崩溃 → 自动重启 → 掐断所有在途流式请求」的最坏情况。
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});

server.listen(PORT, () => {
  console.log(`Manifold chat-demo 已启动: http://localhost:${PORT}`);
  console.log(`上游 sub2api: ${BASE}`);
});
