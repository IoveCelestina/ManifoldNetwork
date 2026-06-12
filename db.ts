// Manifold 会话存储 —— 零依赖，用 Node 24 内置的 node:sqlite。
//
// 单文件 SQLite，按 sub2api 的 user_id 隔离对话。整条会话（文字 + base64 图）以一行 JSON 存，
// 列表查询不取 data 列（前端按需再拉单条）。所有读写走预编译参数化语句，杜绝 SQL 注入。
//
// 注意：node:sqlite 在 Node 24 仍是 experimental（启动会有一行 ExperimentalWarning），
// 生产可用 NODE_OPTIONS=--no-warnings 静音，并把 node 版本钉死。
//
// 本文件是 TS：运行时由 Node 24 的 type stripping 直接执行（仅擦类型、不做检查、无构建产物），
// 故沿用 CommonJS 的 require/module.exports，只补类型注解，保证 100% 可擦除。

const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH: string = process.env.DB_PATH || path.join(__dirname, 'manifold.db');

// 每用户配额（防单账号 / 泄露凭证撑爆磁盘）。身份是 sub2api 鉴过的 user_id，故按 uid 限。
//   STORE_MAX_CONVERSATIONS  单账号最多保存的对话条数
//   STORE_MAX_BYTES_PER_USER 单账号所有对话 data 列的总字节上限（含 base64 图）
const MAX_CONV_PER_USER = Number(process.env.STORE_MAX_CONVERSATIONS || 500);
const MAX_BYTES_PER_USER = Number(process.env.STORE_MAX_BYTES_PER_USER || 200 * 1024 * 1024);

// node:sqlite 经 require 引入（值为 any）；这里定义最小预编译语句接口，给调用处一点类型护栏。
interface Stmt {
  all(...params: unknown[]): any[];
  get(...params: unknown[]): any;
  run(...params: unknown[]): unknown;
}

// 对外的会话形状
interface ConvMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
interface ConvFull extends ConvMeta {
  messages: unknown[];
}
// 写入入参：前端序列化后的会话（字段可能缺省，运行时再兜底）
interface ConvInput {
  id: string | number;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messages?: unknown[];
}
type UpsertResult =
  | { ok: true }
  | { ok: false; code: 'quota_conversations' | 'quota_bytes'; limit: number };

const db = new DatabaseSync(DB_PATH);

// WAL：多读 + 单写互不阻塞；busy_timeout：撞写时等待而非立刻抛 SQLITE_BUSY。
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    uid        INTEGER NOT NULL,
    id         TEXT    NOT NULL,
    title      TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    data       TEXT    NOT NULL,
    PRIMARY KEY (uid, id)
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_conv_uid_updated ON conversations(uid, updated_at DESC)');

// 预编译语句：复用、快、且天然防注入。
const stmtList: Stmt = db.prepare(
  'SELECT id, title, created_at, updated_at FROM conversations WHERE uid = ? ORDER BY updated_at DESC'
);
const stmtGet: Stmt = db.prepare(
  'SELECT id, title, created_at, updated_at, data FROM conversations WHERE uid = ? AND id = ?'
);
const stmtUpsert: Stmt = db.prepare(`
  INSERT INTO conversations (uid, id, title, created_at, updated_at, data)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(uid, id) DO UPDATE SET
    title      = excluded.title,
    updated_at = excluded.updated_at,
    data       = excluded.data
`);
const stmtDel: Stmt = db.prepare('DELETE FROM conversations WHERE uid = ? AND id = ?');

// 配额核算：CAST(... AS BLOB) 让 LENGTH 按字节算（默认 TEXT 是按字符数，CJK 会偏小）。
const stmtUsage: Stmt = db.prepare(
  'SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(data AS BLOB))), 0) AS bytes FROM conversations WHERE uid = ?'
);
const stmtRowLen: Stmt = db.prepare(
  'SELECT LENGTH(CAST(data AS BLOB)) AS len FROM conversations WHERE uid = ? AND id = ?'
);

// 列表：只回元数据（不含 data），供侧栏渲染；正文按需走 getOne。
function listMeta(uid: number): ConvMeta[] {
  return stmtList.all(uid).map((r: any) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// 单条：含 messages（data 反序列化）。不存在返回 null。
function getOne(uid: number, id: string): ConvFull | null {
  const r = stmtGet.get(uid, id);
  if (!r) return null;
  let messages: unknown[] = [];
  try { messages = JSON.parse(r.data)?.messages || []; } catch { /* data 损坏则当空对话 */ }
  return {
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messages,
  };
}

// 写入/更新：conv = { id, title, createdAt, updatedAt, messages }
// 返回 { ok: true } 或 { ok: false, code, limit }（超配额）。先核算再写，避免越权撑爆磁盘。
function upsert(uid: number, conv: ConvInput): UpsertResult {
  const now = Date.now();
  const id = String(conv.id);
  const data = JSON.stringify({ messages: Array.isArray(conv.messages) ? conv.messages : [] });
  const newLen = Buffer.byteLength(data, 'utf8');

  const usage = stmtUsage.get(uid);                 // { count, bytes }
  const existing = stmtRowLen.get(uid, id);         // 覆盖已有会话不占新名额
  if (!existing && usage.count >= MAX_CONV_PER_USER) {
    return { ok: false, code: 'quota_conversations', limit: MAX_CONV_PER_USER };
  }
  const oldLen = existing ? existing.len : 0;
  if (usage.bytes - oldLen + newLen > MAX_BYTES_PER_USER) {
    return { ok: false, code: 'quota_bytes', limit: MAX_BYTES_PER_USER };
  }

  stmtUpsert.run(
    uid,
    id,
    String(conv.title || ''),
    Number(conv.createdAt) || now,
    Number(conv.updatedAt) || now,
    data
  );
  return { ok: true };
}

function del(uid: number, id: string | number): void {
  stmtDel.run(uid, String(id));
}

// ── 服务端会话（sessions）─────────────────────────────────────────
// token / jwt / refresh / api_key 只活在这里：浏览器仅持一个 httpOnly cookie（值 = token）。
// uid 可为 NULL —— 免登录贴 key 模式建的临时 session 没有 sub2api 用户身份。
// email / key_label / key_platform 是为 /api/session/me 展示缓存的非敏感字段（不含 key 明文）。

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token        TEXT PRIMARY KEY,
    uid          INTEGER,
    jwt          TEXT,
    refresh      TEXT,
    api_key      TEXT,
    email        TEXT,
    key_label    TEXT,
    key_platform TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid)');

interface SessionRow {
  token: string;
  uid: number | null;
  jwt: string | null;
  refresh: string | null;
  api_key: string | null;
  email: string | null;
  key_label: string | null;
  key_platform: string | null;
  created_at: number;
  expires_at: number;
}
interface CreateSessionInput {
  uid?: number | null;
  jwt?: string | null;
  refresh?: string | null;
  api_key?: string | null;
  email?: string | null;
  key_label?: string | null;
  key_platform?: string | null;
  ttlMs?: number;
}

const stmtSessIns: Stmt = db.prepare(`
  INSERT INTO sessions (token, uid, jwt, refresh, api_key, email, key_label, key_platform, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtSessGet: Stmt = db.prepare('SELECT * FROM sessions WHERE token = ?');
const stmtSessDel: Stmt = db.prepare('DELETE FROM sessions WHERE token = ?');
const stmtSessTokens: Stmt = db.prepare('UPDATE sessions SET jwt = ?, refresh = ? WHERE token = ?');
const stmtSessKey: Stmt = db.prepare(
  'UPDATE sessions SET api_key = ?, key_label = ?, key_platform = ? WHERE token = ?'
);

// 新建 session，返回随机 256-bit token（即 cookie 值）。
function createSession(input: CreateSessionInput): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  stmtSessIns.run(
    token,
    input.uid ?? null,
    input.jwt ?? null,
    input.refresh ?? null,
    input.api_key ?? null,
    input.email ?? null,
    input.key_label ?? null,
    input.key_platform ?? null,
    now,
    now + (input.ttlMs || SESSION_TTL_MS)
  );
  return token;
}

// 读 session：过期即删并返回 null。
function readSession(token: string | null): SessionRow | null {
  if (!token) return null;
  const r = stmtSessGet.get(token) as SessionRow | undefined;
  if (!r) return null;
  if (r.expires_at <= Date.now()) { stmtSessDel.run(token); return null; }
  return r;
}

function deleteSession(token: string | null): void {
  if (token) stmtSessDel.run(token);
}

// 刷新上游令牌后更新（移植前端 tryRefresh 到服务端）。
function updateSessionTokens(token: string, jwt: string | null, refresh: string | null): void {
  stmtSessTokens.run(jwt, refresh, token);
}

// 选定/切换 key 后更新（api_key 明文留服务端，label/platform 供 me 展示）。
function updateSessionKey(
  token: string,
  apiKey: string | null,
  keyLabel: string | null,
  keyPlatform: string | null
): void {
  stmtSessKey.run(apiKey, keyLabel, keyPlatform, token);
}

// 优雅关闭时把 WAL 合并回主库（TRUNCATE 顺带清空 WAL 文件）。失败不致命——WAL 本身已 fsync，不丢数据。
function checkpoint(): void {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
}

module.exports = {
  listMeta, getOne, upsert, del, DB_PATH,
  createSession, readSession, deleteSession, updateSessionTokens, updateSessionKey,
  SESSION_TTL_MS, checkpoint,
};
