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

// ── Phase 1：拆分的数据模型（messages / blobs / message_blobs）─────────
// 一条消息一行（只 INSERT，不再重写整段会话）；图片内容寻址（blobs.hash = sha256），二进制落 BLOB_DIR。
// conversations 表复用：Phase 1 新会话 data 列写空串；老 data 迁移后保留以便回退。

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    conv_id    TEXT    NOT NULL,
    uid        INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    role       TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    model      TEXT,
    text       TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conv_id, seq)');
db.exec(`
  CREATE TABLE IF NOT EXISTS blobs (
    hash       TEXT PRIMARY KEY,
    mime       TEXT    NOT NULL,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS message_blobs (
    message_id TEXT    NOT NULL,
    blob_hash  TEXT    NOT NULL,
    ord        INTEGER NOT NULL DEFAULT 0,
    name       TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (message_id, blob_hash)
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_mb_hash ON message_blobs(blob_hash)');
// Phase 2：已存在的库补 name 列（文件名按「消息↔blob 链接」存，同 hash 可不同名）。重复跑报 duplicate column，忽略。
try { db.exec("ALTER TABLE message_blobs ADD COLUMN name TEXT NOT NULL DEFAULT ''"); } catch { /* 列已存在 */ }

interface ConvMetaRow { id: string; title: string; createdAt: number; updatedAt: number; }
interface BlobRef { hash: string; name: string; mime: string; size: number; }
interface MessageOut {
  id: string; role: string; kind: string; model: string | null;
  text: string; seq: number; createdAt: number; blobs: BlobRef[];
}
interface InsertMessageInput {
  id: string; convId: string; uid: number; seq: number;
  role: string; kind: string; model?: string | null; text?: string;
}

// 会话（conversations 表，Phase 1 不写 data 列）
const stmtConvList2: Stmt = db.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE uid = ? ORDER BY updated_at DESC');
const stmtConvGet2: Stmt = db.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE uid = ? AND id = ?');
const stmtConvIns2: Stmt = db.prepare("INSERT INTO conversations (uid, id, title, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, '')");
const stmtConvRename: Stmt = db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE uid = ? AND id = ?');
const stmtConvTouch: Stmt = db.prepare('UPDATE conversations SET updated_at = ? WHERE uid = ? AND id = ?');
const stmtConvDel2: Stmt = db.prepare('DELETE FROM conversations WHERE uid = ? AND id = ?');
// 消息
const stmtMsgIns: Stmt = db.prepare('INSERT INTO messages (id, conv_id, uid, seq, role, kind, model, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
// 一律带 uid 过滤：即使 conv_id 跨 uid 碰撞，也不会读/删到他人消息（纵深防御）。
const stmtMsgList: Stmt = db.prepare('SELECT * FROM messages WHERE conv_id = ? AND uid = ? ORDER BY seq');
const stmtMsgNextSeq: Stmt = db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM messages WHERE conv_id = ? AND uid = ?');
const stmtMsgDelByConv: Stmt = db.prepare('DELETE FROM messages WHERE conv_id = ? AND uid = ?');
const stmtMsgHasConv: Stmt = db.prepare('SELECT 1 FROM messages WHERE conv_id = ? AND uid = ? LIMIT 1');
// blob
const stmtBlobIns: Stmt = db.prepare('INSERT OR IGNORE INTO blobs (hash, mime, size, created_at) VALUES (?, ?, ?, ?)');
const stmtBlobGet: Stmt = db.prepare('SELECT hash, mime, size FROM blobs WHERE hash = ?');
const stmtMbIns: Stmt = db.prepare('INSERT OR IGNORE INTO message_blobs (message_id, blob_hash, ord, name) VALUES (?, ?, ?, ?)');
const stmtMbByMsg: Stmt = db.prepare('SELECT mb.blob_hash AS hash, mb.name, b.mime, b.size FROM message_blobs mb JOIN blobs b ON b.hash = mb.blob_hash WHERE mb.message_id = ? ORDER BY mb.ord');
const stmtMbDelByConv: Stmt = db.prepare('DELETE FROM message_blobs WHERE message_id IN (SELECT id FROM messages WHERE conv_id = ? AND uid = ?)');
const stmtBlobOwn: Stmt = db.prepare('SELECT 1 FROM messages m JOIN message_blobs mb ON m.id = mb.message_id WHERE m.uid = ? AND mb.blob_hash = ? LIMIT 1');
// 孤儿 blob：无任何 message_blobs 引用。带 created_at 宽限过滤——刚上传但还没挂到消息上的 blob
// （前端「先传 blob 拿 hash → 再发消息挂载」之间的窗口）不能被 GC 误删。
const stmtBlobOrphans: Stmt = db.prepare('SELECT hash FROM blobs WHERE created_at < ? AND hash NOT IN (SELECT DISTINCT blob_hash FROM message_blobs)');
const stmtBlobDel: Stmt = db.prepare('DELETE FROM blobs WHERE hash = ?');

function listConvs(uid: number): ConvMetaRow[] {
  return stmtConvList2.all(uid).map((r: any) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
}
function getConvMeta(uid: number, id: string): ConvMetaRow | null {
  const r = stmtConvGet2.get(uid, id);
  return r ? { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } : null;
}
function createConv(uid: number, id: string, title: string): void {
  const now = Date.now();
  stmtConvIns2.run(uid, id, title || '新对话', now, now);
}
function renameConv(uid: number, id: string, title: string): void {
  stmtConvRename.run(title, Date.now(), uid, id);
}
function touchConv(uid: number, id: string): void {
  stmtConvTouch.run(Date.now(), uid, id);
}
// 删会话：连带 messages + message_blobs，单事务。blob 文件留给 GC（orphanBlobs）。
function deleteConv(uid: number, id: string): void {
  if (!stmtConvGet2.get(uid, id)) return;
  db.exec('BEGIN');
  try {
    stmtMbDelByConv.run(id, uid);
    stmtMsgDelByConv.run(id, uid);
    stmtConvDel2.run(uid, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// 该会话是否已有 messages（迁移幂等判断用）
function convHasMessages(convId: string, uid: number): boolean {
  return !!stmtMsgHasConv.get(convId, uid);
}

function nextSeq(convId: string, uid: number): number {
  return (stmtMsgNextSeq.get(convId, uid) as any).n;
}
function insertMessage(m: InsertMessageInput): void {
  stmtMsgIns.run(m.id, m.convId, m.uid, m.seq, m.role, m.kind, m.model ?? null, m.text ?? '', Date.now());
}
function getMessages(convId: string, uid: number): MessageOut[] {
  return stmtMsgList.all(convId, uid).map((r: any) => ({
    id: r.id, role: r.role, kind: r.kind, model: r.model, text: r.text, seq: r.seq, createdAt: r.created_at,
    blobs: stmtMbByMsg.all(r.id).map((b: any) => ({ hash: b.hash, name: b.name || '', mime: b.mime, size: b.size })),
  }));
}

function insertBlob(hash: string, mime: string, size: number): void {
  stmtBlobIns.run(hash, mime, size, Date.now());
}
function getBlobMeta(hash: string): { hash: string; mime: string; size: number } | null {
  const r = stmtBlobGet.get(hash);
  return r ? { hash: r.hash, mime: r.mime, size: r.size } : null;
}
function linkBlob(messageId: string, hash: string, ord: number, name = ''): void {
  stmtMbIns.run(messageId, hash, ord, name);
}
// blob 鉴权：当前 uid 是否拥有引用该 hash 的消息
function userOwnsBlob(uid: number, hash: string): boolean {
  return !!stmtBlobOwn.get(uid, hash);
}
// 孤儿 blob 的 hash 列表（GC 用）。只返回 created_at < beforeMs 的，给新上传留宽限期。
function orphanBlobs(beforeMs: number = Number.MAX_SAFE_INTEGER): string[] {
  return stmtBlobOrphans.all(beforeMs).map((r: any) => r.hash);
}
// 删 blob 元数据行（文件由调用方删）。
function deleteBlob(hash: string): void {
  stmtBlobDel.run(hash);
}

// 迁移用：列出所有会话（含 data 列），供 migrate-phase1.ts 把老 JSON-blob 拆进新表。
const stmtConvAll: Stmt = db.prepare('SELECT uid, id, data FROM conversations');
function listConvsForMigration(): any[] { return stmtConvAll.all(); }

// 优雅关闭时把 WAL 合并回主库（TRUNCATE 顺带清空 WAL 文件）。失败不致命——WAL 本身已 fsync，不丢数据。
function checkpoint(): void {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
}

module.exports = {
  listMeta, getOne, upsert, del, DB_PATH,
  createSession, readSession, deleteSession, updateSessionTokens, updateSessionKey,
  SESSION_TTL_MS, checkpoint,
  // Phase 1：会话/消息/blob 数据访问层
  listConvs, getConvMeta, createConv, renameConv, touchConv, deleteConv, convHasMessages,
  nextSeq, insertMessage, getMessages,
  insertBlob, getBlobMeta, linkBlob, userOwnsBlob, orphanBlobs, deleteBlob, listConvsForMigration,
};
