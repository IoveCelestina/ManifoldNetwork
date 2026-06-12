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
const STORE_MAX_BODY = 25 * 1024 * 1024;     // /store 写入体积上限，防 DB 撑肿
const USER_CACHE_TTL = 60 * 1000;            // token→user_id 解析缓存 TTL
const CONV_ID_RE = /^[A-Za-z0-9_-]{1,128}$/; // 合法会话 id（与前端 c_xxx 命名一致）
const userCache = new Map();                 // token -> { uid, exp }

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

const MAX_BODY = 50 * 1024 * 1024; // 识图 base64 也用不了 50MB；防恶意大包打爆内存

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
    db.upsert(uid, conv);
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
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
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
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  // 兜底：任何同步异常都不该掀翻进程。proxy() 是异步、自带 .catch；serveStatic() 是同步，
  // 这里再包一层，把请求级错误关进 500，而不是让它变成 uncaughtException。
  try {
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
