// Manifold chat-demo 服务器：静态文件 + 服务端推理 + cookie 鉴权 + 同源反向代理。
//
// 浏览器只跟本服务同源通信，且不再持有 key/JWT —— 凭证活在服务端 session（见 db.ts），
// 浏览器仅持一个 httpOnly cookie。
//   /api/session/*      登录 / 2FA / 免登录贴 key / 登出 / me（服务端会话）
//   /api/keys[/select]  账户 key 列表 / 选定（key 明文不出服务端）
//   /api/models         透传上游 /v1/models（服务端用 session.api_key 调）
//   /api/conversations/:id/messages  聊天 SSE（服务端注入系统提示 + 用 session.api_key 调上游）
//   /store/*            会话存储（按 session.uid 隔离，沿用整条 JSON blob 模型）
//   /api/v1/* /v1/*     旧的同源代理（迁移期保留，0d 下线）
//
// 用法：node server.ts  ｜  SUB2API_BASE=https://zstuacm.xyz PORT=8787 node server.ts
//
// 本文件是 TS：Node 24 的 type stripping 直接执行（仅擦类型、无构建）。沿用 CommonJS 的
// require/module，只补类型注解；req/res 等 Node 类型用 import type 引入（编译期擦除）。

import type { IncomingMessage, ServerResponse } from 'node:http';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const BASE: string = (process.env.SUB2API_BASE || 'https://zstuacm.xyz').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'public');

// 旧的浏览器直打代理（/api/v1/* 与 /v1/*）。前端 0b 起已全改走 /api/*，不再用它。
// 迁移期默认保留作回退；生产灰度确认新链路无误后，设 LEGACY_PROXY=off 即下线（无需改代码、可随时回退）。
const LEGACY_PROXY = (process.env.LEGACY_PROXY || 'on').toLowerCase() !== 'off';

// ── 会话存储 + 服务端 session（node:sqlite 单文件）──────────────────
const db = require('./db.ts');
const STORE_MAX_BODY = 100 * 1024 * 1024;    // /store 单条对话写入上限，防 DB 撑肿
const CONV_ID_RE = /^[A-Za-z0-9_-]{1,128}$/; // 合法会话 id（与前端 c_xxx 命名一致）

// cookie 规格：HttpOnly + SameSite=Lax + Path=/。Secure 默认按 X-Forwarded-Proto 自动判定
// （生产经 Caddy/CF 是 https → 带 Secure；本地直连 http → 不带，否则浏览器拒存 cookie）。
// 也可用 COOKIE_SECURE=on/off 强制。
const COOKIE_NAME = 'mf_session';
const COOKIE_SECURE_MODE = (process.env.COOKIE_SECURE || 'auto').toLowerCase();

// Codex 后端默认一副「代码工作区」腔调，会跟用户扯查项目结构/生成文件；用系统提示掰回闲聊场景。
// 0b 起系统提示移到后端，前端再也看不到/改不了。
const CHAT_SYSTEM_PROMPT =
  '你是一个友好的 AI 助手，在网页聊天界面中与用户对话，用用户的语言回复。' +
  '你没有文件系统、代码工作区或运行环境，不能创建/保存/输出文件；' +
  '所有内容都直接以文字和 Markdown 在对话里呈现。' +
  '你自己不能生成图片：用户想要生成或修改图片时，告诉他把右上角模型切换到 gpt-image-2 后直接描述画面（可附参考图）。';

// ── 按 IP 限流（令牌桶）─────────────────────────────────────────
// 本服务设计为只跑在反代（Caddy）后面：真实客户端 IP 由 Caddy 经 X-Forwarded-For 透传进来。
// ⚠ 直接裸暴露到公网时 XFF 可伪造，限流即失效。
//   auth 档    —— 盖所有登录入口（旧 /api/v1/auth/login* 与新 /api/session/login|2fa|keylogin），挡撞密码
//   general 档 —— 盖 /api /v1 /store，挡刷接口 / 爬；静态资源不计
// 每档 burst 个令牌、windowSec 内匀速回满，超额回 429 + Retry-After。RATE_LIMIT=off 可整体关闭。
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
type RlTier = keyof typeof RL_TIERS;
const rlBuckets = new Map<string, { tokens: number; last: number }>();

function rlTierFor(url: string): RlTier | null {
  if (
    url.startsWith('/api/v1/auth/login') ||
    url.startsWith('/api/session/login') ||
    url.startsWith('/api/session/2fa') ||
    url.startsWith('/api/session/keylogin')
  ) return 'auth';                            // 所有登录入口：严格档挡撞密码
  if (url.startsWith('/api/') || url.startsWith('/v1/') || url.startsWith('/store/')) return 'general';
  return null;                                // 静态资源：不限流
}

function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();   // 最左 = 原始客户端（Caddy 只塞一个值）
  return req.socket?.remoteAddress || 'unknown';
}

function rlTake(tier: RlTier, ip: string, now: number): { ok: true } | { ok: false; retryAfter: number } {
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

function rateLimited(req: IncomingMessage, res: ServerResponse): boolean {
  if (!RL_ENABLED) return false;
  const tier = rlTierFor(req.url || '');
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

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, b] of rlBuckets) if (b.last < cutoff) rlBuckets.delete(k);
}, 10 * 60 * 1000).unref();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

// CSP：DOMPurify 之上的兜底——脚本/连接/样式全锁同源。data:/blob: 仅放给 img。
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

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

// 只透传这些请求头给旧代理；host/origin/cookie 等一律不带。
const FORWARD_REQ_HEADERS = [
  'content-type',
  'authorization',
  'x-api-key',
  'accept',
  'accept-language',
  'x-forwarded-for',
  'x-real-ip',
];

// 这些响应头不能照抄：fetch 已解压、长度和编码由本服务重新决定。
const SKIP_RES_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
]);

const MAX_BODY = 100 * 1024 * 1024; // 单请求体上限；防恶意大包打爆内存。

function collectBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
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

async function readJsonBody(req: IncomingMessage, limit = MAX_BODY): Promise<any> {
  const buf = await collectBody(req, limit);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// 背压泵：把上游 web ReadableStream 转发到 res，客户端消费慢时停一拍。返回中断原因（空串=正常）。
async function pumpBody(webBody: any, res: ServerResponse): Promise<string> {
  let truncatedBy = '';
  for await (const chunk of Readable.fromWeb(webBody)) {
    if (res.destroyed) { truncatedBy = 'client-destroyed'; break; }
    if (!res.write(chunk)) {
      const drained = await new Promise<boolean>((resolve) => {
        const onDrain = () => { cleanup(); resolve(true); };
        const onClose = () => { cleanup(); resolve(false); };
        const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); };
        res.once('drain', onDrain);
        res.once('close', onClose);
      });
      if (!drained) { truncatedBy = 'client-closed'; break; }
    }
  }
  return truncatedBy;
}

// ── 旧同源代理（/api/v1/* /v1/*；迁移期保留，0d 下线）──────────────
async function proxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const target = BASE + req.url;
  const headers: Record<string, string> = {};
  for (const h of FORWARD_REQ_HEADERS) {
    const v = req.headers[h];
    if (v) headers[h] = Array.isArray(v) ? v.join(', ') : v;
  }
  headers['accept-encoding'] = 'identity';

  let body: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await collectBody(req);
    } catch (err: any) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=utf-8', 'Connection': 'close' });
      res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
      return;
    }
    if (body.length === 0) body = undefined;
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(new Error('上游超时')), 10 * 60 * 1000);
  res.on('close', () => {
    if (!res.writableEnded) ctrl.abort(new Error('客户端断开'));
  });

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual', signal: ctrl.signal });
  } catch (err: any) {
    clearTimeout(timeout);
    console.error(`[proxy] ${req.method} ${req.url} -> FAIL ${err.message} (${Date.now() - started}ms)`);
    if (!res.writableEnded) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Connection': 'close' });
      res.end(JSON.stringify({ error: { message: `代理到上游失败: ${err.message}`, type: 'proxy_error', upstream: BASE } }));
    }
    return;
  }

  const resHeaders: Record<string, string> = {};
  upstream.headers.forEach((v: string, k: string) => {
    if (!SKIP_RES_HEADERS.has(k.toLowerCase())) resHeaders[k] = v;
  });
  res.writeHead(upstream.status, resHeaders);

  // 生图链路诊断：记录响应头尾片段，定位截断/格式问题
  const diag = (req.url || '').startsWith('/v1/images/');
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
    } catch (err: any) {
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

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ── cookie / session 工具 ──────────────────────────────────────────
function parseCookies(req: IncomingMessage): Record<string, string> {
  const h = req.headers['cookie'];
  if (!h) return {};
  const out: Record<string, string> = {};
  for (const part of String(h).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function getSessionToken(req: IncomingMessage): string | null {
  return parseCookies(req)[COOKIE_NAME] || null;
}
function cookieSecure(req: IncomingMessage): boolean {
  if (COOKIE_SECURE_MODE === 'on') return true;
  if (COOKIE_SECURE_MODE === 'off') return false;
  return String(req.headers['x-forwarded-proto'] || '').includes('https'); // auto
}
function setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string, maxAgeMs: number): void {
  const parts = [`${COOKIE_NAME}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (cookieSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(req: IncomingMessage, res: ServerResponse): void {
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (cookieSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// 写操作 CSRF 兜底：浏览器对跨站写一定带 Origin；同源或无 Origin 放行。配合 SameSite=Lax 双保险。
function sameOrigin(req: IncomingMessage): boolean {
  const o = req.headers['origin'];
  if (!o) return true;
  try { return new URL(o).host === req.headers['host']; } catch { return false; }
}

function maskKey(k: string | null | undefined): string {
  if (!k) return '';
  return k.length <= 12 ? k : `${k.slice(0, 7)}…${k.slice(-4)}`;
}

// 把前端传来的 dataURL 参考图还原成 Blob，供 /v1/images/edits 的 multipart 用。
function dataUrlToBlob(dataUrl: string): Blob {
  const i = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, i);
  const b64 = dataUrl.slice(i + 1);
  const mime = (head.match(/^data:(.*?)[;,]/) || [])[1] || 'image/png';
  return new Blob([Buffer.from(b64, 'base64')], { type: mime });
}

// ── 上游（sub2api）调用辅助 ─────────────────────────────────────────
// 复刻前端 unwrap：sub2api 业务接口返回 {code,message,data}，也兼容裸返回。
function unwrapUpstream(json: any): any {
  if (json && typeof json === 'object' && 'code' in json) {
    const ok = json.code === 0 || json.code === 200 || json.success === true;
    if (!ok) throw Object.assign(new Error(json.message || `上游错误 code=${json.code}`), { status: 400 });
    return json.data;
  }
  return json;
}

interface UpstreamOpts { token?: string | null; body?: any }
async function upstreamJson(method: string, pathStr: string, opts: UpstreamOpts = {}): Promise<any> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const r = await fetch(BASE + pathStr, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = null;
  try { json = await r.json(); } catch { /* 空 body */ }
  if (!r.ok) {
    const msg = json?.message || json?.error?.message || `HTTP ${r.status}`;
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return unwrapUpstream(json);
}

// 服务端 refresh（移植前端 tryRefresh）：用 session.refresh 换新 jwt，并发 401 共享同一次刷新。
const refreshInflight = new Map<string, Promise<boolean>>();
async function refreshSession(session: any): Promise<boolean> {
  if (!session?.token || !session.refresh) return false;
  let p = refreshInflight.get(session.token);
  if (!p) {
    p = (async () => {
      try {
        const data = await upstreamJson('POST', '/api/v1/auth/refresh', { body: { refresh_token: session.refresh } });
        if (!data?.access_token) return false;
        const newRefresh = data.refresh_token || session.refresh;
        db.updateSessionTokens(session.token, data.access_token, newRefresh);
        session.jwt = data.access_token;          // 更新内存副本，后续重试即用新 jwt
        session.refresh = newRefresh;
        return true;
      } catch { return false; }
      finally { refreshInflight.delete(session.token); }
    })();
    refreshInflight.set(session.token, p);
  }
  return p;
}

// 带 jwt 调上游，遇 401 自动刷新一次再重试。
async function upstreamJsonAuth(session: any, method: string, pathStr: string, body?: any): Promise<any> {
  try {
    return await upstreamJson(method, pathStr, { token: session.jwt, body });
  } catch (e: any) {
    if (e.status === 401 && await refreshSession(session)) {
      return await upstreamJson(method, pathStr, { token: session.jwt, body });
    }
    throw e;
  }
}

// 解析 sub2api 的 key 列表（复刻前端 loadAccountKeys）：openai 平台排前。
function parseKeys(keysData: any, groupsData: any): any[] {
  const arr = Array.isArray(keysData) ? keysData : (keysData?.items || keysData?.list || keysData?.keys || []);
  const groups = Array.isArray(groupsData) ? groupsData : (groupsData?.items || groupsData?.list || groupsData?.groups || []);
  const platformByGroup: Record<string, string> = {};
  for (const g of groups) if (g && g.id !== undefined) platformByGroup[g.id] = g.platform || '';
  const keys = arr.map((k: any) => ({
    id: k.id,
    key: k.key || '',
    name: k.name || `key-${k.id}`,
    platform: platformByGroup[k.group_id] || k.platform || k.group?.platform || '',
    status: k.status,
  }));
  keys.sort((a: any, b: any) => Number(b.platform === 'openai') - Number(a.platform === 'openai'));
  return keys;
}
async function fetchKeysByToken(jwt: string): Promise<any[]> {
  const [k, g] = await Promise.all([
    upstreamJson('GET', '/api/v1/keys?page=1&page_size=100', { token: jwt }),
    upstreamJson('GET', '/api/v1/groups/available', { token: jwt }).catch(() => null),
  ]);
  return parseKeys(k, g);
}
async function fetchKeysAuth(session: any): Promise<any[]> {
  const [k, g] = await Promise.all([
    upstreamJsonAuth(session, 'GET', '/api/v1/keys?page=1&page_size=100'),
    upstreamJsonAuth(session, 'GET', '/api/v1/groups/available').catch(() => null),
  ]);
  return parseKeys(k, g);
}

// ── /api/* 应用路由（服务端推理 + cookie 鉴权）────────────────────────

// 登录成功 → 取 uid/email、选 key、建 session、种 cookie。
async function establishSession(req: IncomingMessage, res: ServerResponse, data: any): Promise<void> {
  const jwt = data?.access_token;
  if (!jwt) { sendJson(res, 502, { error: { message: '上游未返回 access_token' } }); return; }
  const refresh = data.refresh_token || null;

  let uid: number | null = null;
  let email: string | null = data?.user?.email || null;
  try {
    const me = await upstreamJson('GET', '/api/v1/auth/me', { token: jwt });
    const raw = me?.id ?? me?.user_id ?? me?.user?.id;
    if (raw !== undefined && raw !== null && Number.isFinite(Number(raw))) uid = Number(raw);
    email = me?.email || email;
  } catch { /* me 失败不阻塞登录 */ }

  // 选 key：唯一/首个有明文的 key（openai 已排前）。账户无 key 时留空，前端引导去设置。
  let apiKey: string | null = null, keyLabel: string | null = null, keyPlatform: string | null = null;
  try {
    const usable = (await fetchKeysByToken(jwt)).filter((k) => k.key);
    if (usable[0]) { apiKey = usable[0].key; keyLabel = usable[0].name; keyPlatform = usable[0].platform; }
  } catch { /* key 拉取失败不阻塞登录 */ }

  const token = db.createSession({ uid, jwt, refresh, api_key: apiKey, email, key_label: keyLabel, key_platform: keyPlatform });
  setSessionCookie(req, res, token, db.SESSION_TTL_MS);
  sendJson(res, 200, { ok: true });
}

async function apiLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: { message: '请求体非法' } }); return; }
  try {
    const data = await upstreamJson('POST', '/api/v1/auth/login', { body: { email: body.email, password: body.password } });
    if (data?.temp_token && !data?.access_token) { sendJson(res, 200, { need_2fa: true, ticket: data.temp_token }); return; }
    await establishSession(req, res, data);
  } catch (e: any) {
    sendJson(res, e.status || 502, { error: { message: e.message || '登录失败' } });
  }
}

async function api2fa(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: { message: '请求体非法' } }); return; }
  try {
    const data = await upstreamJson('POST', '/api/v1/auth/login/2fa', { body: { temp_token: body.ticket, totp_code: body.code } });
    await establishSession(req, res, data);
  } catch (e: any) {
    sendJson(res, e.status || 502, { error: { message: e.message || '验证失败' } });
  }
}

async function apiKeylogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: { message: '请求体非法' } }); return; }
  const key = String(body.key || '').trim();
  if (!key) { sendJson(res, 400, { error: { message: 'key 不能为空' } }); return; }
  const token = db.createSession({ api_key: key, key_label: maskKey(key) });
  setSessionCookie(req, res, token, db.SESSION_TTL_MS);
  sendJson(res, 200, { ok: true });
}

async function apiLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = db.readSession(getSessionToken(req));
  if (session) {
    if (session.refresh) {
      upstreamJson('POST', '/api/v1/auth/logout', { token: session.jwt, body: { refresh_token: session.refresh } }).catch(() => {});
    }
    db.deleteSession(session.token);
  }
  clearSessionCookie(req, res);
  sendJson(res, 200, { ok: true });
}

function apiMe(res: ServerResponse, session: any): void {
  sendJson(res, 200, {
    email: session.email || null,
    uid: session.uid,
    key: session.api_key ? { label: session.key_label, platform: session.key_platform, masked: maskKey(session.api_key) } : null,
  });
}

async function apiKeys(res: ServerResponse, session: any): Promise<void> {
  if (session.uid === null) { sendJson(res, 200, { keys: [] }); return; } // 贴 key 模式没有账户 key 列表
  try {
    const keys = await fetchKeysAuth(session);
    sendJson(res, 200, {
      keys: keys.map((k) => ({
        id: k.id, label: k.name, platform: k.platform, masked: maskKey(k.key),
        hasKey: !!k.key, selected: !!k.key && k.key === session.api_key,
      })),
    });
  } catch (e: any) {
    sendJson(res, e.status || 502, { error: { message: e.message || '拉取 key 失败' } });
  }
}

async function apiKeysSelect(req: IncomingMessage, res: ServerResponse, session: any): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: { message: '请求体非法' } }); return; }
  if (session.uid === null) { sendJson(res, 400, { error: { message: '贴 key 模式不支持切换账户 key' } }); return; }
  try {
    const k = (await fetchKeysAuth(session)).find((x) => String(x.id) === String(body.id));
    if (!k || !k.key) { sendJson(res, 400, { error: { message: 'key 不存在或不可用' } }); return; }
    db.updateSessionKey(session.token, k.key, k.name, k.platform);
    sendJson(res, 200, { ok: true });
  } catch (e: any) {
    sendJson(res, e.status || 502, { error: { message: e.message || '切换 key 失败' } });
  }
}

// 手动贴 key：把任意 key 存进当前 session（登录态 / keyonly 都可用）。key 进后端 session，不回浏览器。
async function apiKeysManual(req: IncomingMessage, res: ServerResponse, session: any): Promise<void> {
  let body: any;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: { message: '请求体非法' } }); return; }
  const key = String(body.key || '').trim();
  if (!key) { sendJson(res, 400, { error: { message: 'key 不能为空' } }); return; }
  db.updateSessionKey(session.token, key, maskKey(key), 'manual');
  sendJson(res, 200, { ok: true });
}

async function apiModels(res: ServerResponse, session: any): Promise<void> {
  if (!session.api_key) { sendJson(res, 200, { data: [] }); return; } // 无 key → 空列表，前端有兜底
  try {
    const r = await fetch(BASE + '/v1/models', { headers: { 'Authorization': `Bearer ${session.api_key}`, 'Accept': 'application/json' } });
    const json = await r.json().catch(() => ({ data: [] }));
    sendJson(res, r.ok ? 200 : r.status, json);
  } catch (e: any) {
    sendJson(res, 502, { error: { message: '拉取模型失败: ' + e.message } });
  }
}

// 聊天 SSE：注入系统提示 + 用 session.api_key 调上游 /v1/chat/completions，流式转发。
// 0b 不在此落库（前端仍 PUT /store 保存整条会话），落库责任 Phase 1 随 messages 表移到后端。
async function apiMessages(req: IncomingMessage, res: ServerResponse, session: any): Promise<void> {
  if (!session.api_key) { sendJson(res, 400, { error: { message: '尚未设置 key，请先在设置里选/贴一个 key' } }); return; }
  let body: any;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: { message: '请求体非法' } }); return; }
  const model = body.model;
  const history = Array.isArray(body.messages) ? body.messages : [];
  const messages = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...history];

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(new Error('上游超时')), 10 * 60 * 1000);
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(new Error('客户端断开')); });

  let upstream: Response;
  try {
    upstream = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.api_key}`,
        'Accept': 'text/event-stream',
        'accept-encoding': 'identity',
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(timeout);
    sendJson(res, 502, { error: { message: '上游不可达: ' + e.message } });
    return;
  }

  const resHeaders: Record<string, string> = {};
  upstream.headers.forEach((v: string, k: string) => {
    if (!SKIP_RES_HEADERS.has(k.toLowerCase())) resHeaders[k] = v;
  });
  res.writeHead(upstream.status, resHeaders);
  if (upstream.body) {
    res.flushHeaders();
    try { await pumpBody(upstream.body, res); }
    catch (e: any) { console.error(`[messages] stream interrupted: ${e.message}`); }
  }
  clearTimeout(timeout);
  res.end();
}

// 生图：用 session.api_key 调上游。无参考图走 /v1/images/generations，带参考图走 /v1/images/edits
// （multipart，从 dataURL 还原 Blob）。默认流式（绕 CF 100s 首字节限），上游不认 stream 时回退非流式。
async function apiImages(req: IncomingMessage, res: ServerResponse, session: any): Promise<void> {
  if (!session.api_key) { sendJson(res, 400, { error: { message: '尚未设置 key，请先在设置里选/贴一个 key' } }); return; }
  let body: any;
  try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: { message: '请求体非法' } }); return; }
  const { model, prompt, size, quality } = body;
  if (!prompt) { sendJson(res, 400, { error: { message: '缺少 prompt' } }); return; }
  const refImages: string[] = Array.isArray(body.refs) ? body.refs : [];

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(new Error('上游超时')), 10 * 60 * 1000);
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(new Error('客户端断开')); });

  // stream=true 优先；带参考图走 edits(multipart)，否则 generations(JSON)。
  const doRequest = (stream: boolean): Promise<Response> => {
    if (refImages.length) {
      const fd = new FormData();
      fd.append('model', model);
      fd.append('prompt', prompt);
      fd.append('size', size);
      fd.append('n', '1');
      if (quality && quality !== 'auto') fd.append('quality', quality);
      if (stream) { fd.append('stream', 'true'); fd.append('partial_images', '2'); }
      if (refImages.length === 1) {
        fd.append('image', dataUrlToBlob(refImages[0]), 'ref-1.png');
      } else {
        refImages.forEach((u, i) => fd.append('image[]', dataUrlToBlob(u), `ref-${i + 1}.png`));
      }
      return fetch(BASE + '/v1/images/edits', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.api_key}` },
        body: fd,
        signal: ctrl.signal,
      });
    }
    const payload: any = { model, prompt, size, n: 1 };
    if (quality && quality !== 'auto') payload.quality = quality;
    if (stream) { payload.stream = true; payload.partial_images = 2; }
    return fetch(BASE + '/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.api_key}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  };

  const forwardError = (status: number, ctype: string | null, text: string) => {
    clearTimeout(timeout);
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { 'Content-Type': ctype || 'application/json; charset=utf-8' });
    res.end(text);
  };

  try {
    let upstream = await doRequest(true);
    if (!upstream.ok) {
      const errText = await upstream.text();
      // 只有报错明确冲着 stream/partial_images 参数才回退非流式；内容审核类 400 不重试
      if ((upstream.status === 400 || upstream.status === 422) && /stream|partial/i.test(errText)) {
        upstream = await doRequest(false);
        if (!upstream.ok) { forwardError(upstream.status, upstream.headers.get('content-type'), await upstream.text()); return; }
      } else {
        forwardError(upstream.status, upstream.headers.get('content-type'), errText);
        return;
      }
    }
    // 转发（可能是 SSE 流式，也可能是回退后的整包 JSON）
    const resHeaders: Record<string, string> = {};
    upstream.headers.forEach((v: string, k: string) => {
      if (!SKIP_RES_HEADERS.has(k.toLowerCase())) resHeaders[k] = v;
    });
    res.writeHead(upstream.status, resHeaders);
    if (upstream.body) {
      res.flushHeaders();
      try { await pumpBody(upstream.body, res); }
      catch (e: any) { console.error(`[images] stream interrupted: ${e.message}`); }
    }
    clearTimeout(timeout);
    res.end();
  } catch (e: any) {
    clearTimeout(timeout);
    if (!res.writableEnded) {
      if (!res.headersSent) sendJson(res, 502, { error: { message: '生图失败: ' + e.message } });
      else res.end();
    }
  }
}

// /api/* 路由分发。返回 true 表示已接管。
async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url || '').split('?')[0];
  const method = req.method || 'GET';

  // CSRF：写操作校验同源
  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
    sendJson(res, 403, { error: { message: '跨站请求被拒绝' } }); return;
  }

  // 公开路由（无需 session）
  if (url === '/api/session/login' && method === 'POST') return apiLogin(req, res);
  if (url === '/api/session/2fa' && method === 'POST') return api2fa(req, res);
  if (url === '/api/session/keylogin' && method === 'POST') return apiKeylogin(req, res);
  if (url === '/api/session/logout' && method === 'POST') return apiLogout(req, res);

  const session = db.readSession(getSessionToken(req));

  // me：未登录返回空对象（前端据此判断登录态），不报 401
  if (url === '/api/session/me' && method === 'GET') {
    if (!session) { sendJson(res, 200, { email: null, uid: null, key: null }); return; }
    return apiMe(res, session);
  }

  if (!session) { sendJson(res, 401, { error: { message: '未登录或登录已过期' } }); return; }

  if (url === '/api/keys' && method === 'GET') return apiKeys(res, session);
  if (url === '/api/keys/select' && method === 'POST') return apiKeysSelect(req, res, session);
  if (url === '/api/keys/manual' && method === 'POST') return apiKeysManual(req, res, session);
  if (url === '/api/models' && method === 'GET') return apiModels(res, session);

  const mMsg = /^\/api\/conversations\/([^/]+)\/messages$/.exec(url);
  if (mMsg && method === 'POST') {
    if (!CONV_ID_RE.test(decodeURIComponent(mMsg[1]))) { sendJson(res, 400, { error: { message: '非法会话 id' } }); return; }
    return apiMessages(req, res, session);
  }
  const mImg = /^\/api\/conversations\/([^/]+)\/images$/.exec(url);
  if (mImg && method === 'POST') {
    if (!CONV_ID_RE.test(decodeURIComponent(mImg[1]))) { sendJson(res, 400, { error: { message: '非法会话 id' } }); return; }
    return apiImages(req, res, session);
  }

  sendJson(res, 404, { error: { message: 'not found' } });
}

// 这些 /api 前缀归本服务应用路由处理；其余 /api/v1/* /v1/* 仍走旧代理。
function isOwnApi(url: string): boolean {
  return url.startsWith('/api/session/')
    || url === '/api/keys' || url === '/api/keys/select' || url === '/api/keys/manual'
    || url === '/api/models'
    || /^\/api\/conversations\/[^/]+\/(messages|images)/.test(url);
}

// ── 会话存储 /store/*（按 session.uid 隔离）─────────────────────────
// /store/conversations          GET   列表（仅元数据）
// /store/conversations/<id>     GET 单条 / PUT 写入 / DELETE 删除
async function handleStore(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = db.readSession(getSessionToken(req));
  const uid = session?.uid ?? null;             // 贴 key 模式 uid=NULL → 不走服务端存储
  if (uid === null) { sendJson(res, 401, { error: { message: '未登录或登录已过期' } }); return; }

  const segs = (req.url || '').split('?')[0].split('/').filter(Boolean); // ['store','conversations', id?]
  if (segs[1] !== 'conversations') { sendJson(res, 404, { error: { message: 'not found' } }); return; }
  const convId = segs[2] || null;
  if (convId && !CONV_ID_RE.test(convId)) { sendJson(res, 400, { error: { message: '非法会话 id' } }); return; }

  if (!convId) {
    if (req.method === 'GET') { sendJson(res, 200, { conversations: db.listMeta(uid) }); return; }
    sendJson(res, 405, { error: { message: 'method not allowed' } });
    return;
  }

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
    let bodyBuf: Buffer;
    try { bodyBuf = await collectBody(req, STORE_MAX_BODY); }
    catch (err: any) { sendJson(res, err.statusCode || 400, { error: { message: err.message } }); return; }
    let conv: any;
    try { conv = JSON.parse(bodyBuf.toString('utf8')); }
    catch { sendJson(res, 400, { error: { message: 'body 不是合法 JSON' } }); return; }
    if (!conv || conv.id !== convId) { sendJson(res, 400, { error: { message: 'body.id 与路径不一致' } }); return; }
    const result = db.upsert(uid, conv);
    if (!result.ok) {
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

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  // 畸形百分号编码（如 /%、/%ZZ）会让 decodeURIComponent 抛 URIError；必须就地拦成 400。
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
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

  fs.readFile(filePath, (err: NodeJS.ErrnoException | null, data: Buffer) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = CSP;
      headers['X-Frame-Options'] = 'DENY';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  try {
    if (rateLimited(req, res)) return;   // 限流闸门：挡在所有路由之前
    const url = req.url || '';
    if (url.startsWith('/store/')) {
      handleStore(req, res).catch((err: any) => {
        console.error('[store] unhandled:', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end();
      });
    } else if (isOwnApi(url)) {
      handleApi(req, res).catch((err: any) => {
        console.error('[api] unhandled:', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end();
      });
    } else if (url.startsWith('/api/') || url.startsWith('/v1/')) {
      if (!LEGACY_PROXY) {   // 旧直打链路已下线（LEGACY_PROXY=off）
        sendJson(res, 404, { error: { message: '该端点已下线，请使用 /api/* 应用接口', type: 'legacy_disabled' } });
        return;
      }
      proxy(req, res).catch((err: any) => {
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
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});

// ── 优雅关闭 ────────────────────────────────────────────────────────
// 后端已进关键路径（持 session、转发在途 SSE 流）：重启不能再硬掐所有人的流。
// SIGTERM/SIGINT → 停止接新连接、关掉空闲 keep-alive、等在途请求/流自然结束、刷 WAL、退出。
// Docker 默认只给 10s 宽限，长流式（生图）要排空需在 compose 配 stop_grace_period（见 DEPLOY.md）。
let shuttingDown = false;
function gracefulShutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] 收到 ${sig}，开始优雅关闭…`);
  server.close(() => {
    db.checkpoint();
    console.log('[shutdown] 在途请求已排空、WAL 已刷，退出');
    process.exit(0);
  });
  server.closeIdleConnections?.();   // 关掉空闲 keep-alive，否则 close 回调会一直等它们
  const ms = Number(process.env.SHUTDOWN_TIMEOUT_MS || 30000);
  setTimeout(() => {
    console.error(`[shutdown] ${ms}ms 内未排空，强制退出`);
    try { db.checkpoint(); } catch { /* ignore */ }
    process.exit(1);
  }, ms).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, () => {
  console.log(`Manifold chat-demo 已启动: http://localhost:${PORT}`);
  console.log(`上游 sub2api: ${BASE}`);
});
