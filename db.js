// Manifold 会话存储 —— 零依赖，用 Node 24 内置的 node:sqlite。
//
// 单文件 SQLite，按 sub2api 的 user_id 隔离对话。整条会话（文字 + base64 图）以一行 JSON 存，
// 列表查询不取 data 列（前端按需再拉单条）。所有读写走预编译参数化语句，杜绝 SQL 注入。
//
// 注意：node:sqlite 在 Node 24 仍是 experimental（启动会有一行 ExperimentalWarning），
// 生产可用 NODE_OPTIONS=--no-warnings 静音，并把 node 版本钉死。

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'manifold.db');

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
const stmtList = db.prepare(
  'SELECT id, title, created_at, updated_at FROM conversations WHERE uid = ? ORDER BY updated_at DESC'
);
const stmtGet = db.prepare(
  'SELECT id, title, created_at, updated_at, data FROM conversations WHERE uid = ? AND id = ?'
);
const stmtUpsert = db.prepare(`
  INSERT INTO conversations (uid, id, title, created_at, updated_at, data)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(uid, id) DO UPDATE SET
    title      = excluded.title,
    updated_at = excluded.updated_at,
    data       = excluded.data
`);
const stmtDel = db.prepare('DELETE FROM conversations WHERE uid = ? AND id = ?');

// 列表：只回元数据（不含 data），供侧栏渲染；正文按需走 getOne。
function listMeta(uid) {
  return stmtList.all(uid).map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// 单条：含 messages（data 反序列化）。不存在返回 null。
function getOne(uid, id) {
  const r = stmtGet.get(uid, id);
  if (!r) return null;
  let messages = [];
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
function upsert(uid, conv) {
  const now = Date.now();
  const data = JSON.stringify({ messages: Array.isArray(conv.messages) ? conv.messages : [] });
  stmtUpsert.run(
    uid,
    String(conv.id),
    String(conv.title || ''),
    Number(conv.createdAt) || now,
    Number(conv.updatedAt) || now,
    data
  );
}

function del(uid, id) {
  stmtDel.run(uid, String(id));
}

module.exports = { listMeta, getOne, upsert, del, DB_PATH };
