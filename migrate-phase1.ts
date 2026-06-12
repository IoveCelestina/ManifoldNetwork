// Phase 1 一次性迁移：老 conversations.data（单 JSON-blob，含内联 base64 图）→ messages/blobs/message_blobs 表。
//
// 用法（容器内）：
//   docker exec manifold-chat-demo node migrate-phase1.ts
//
// ⚠ 跑前务必备份（见 DEPLOY.md「数据与备份」的 VACUUM INTO + 拷 blobs 目录）。
// 幂等：已有 messages 的会话会跳过，可安全重复跑。老 data 列保留不删（可回退）。
// blob 二进制写入 BLOB_DIR（默认与 DB 同目录的 blobs/，生产命名卷 /data/blobs）。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.ts');

const BLOB_DIR: string = process.env.BLOB_DIR || path.join(path.dirname(db.DB_PATH), 'blobs');
fs.mkdirSync(BLOB_DIR, { recursive: true });

function sha256(buf: Buffer): string { return crypto.createHash('sha256').update(buf).digest('hex'); }
function dataUrlToBuf(dataUrl: string): { buf: Buffer; mime: string } {
  const i = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, i);
  const mime = (head.match(/^data:(.*?)[;,]/) || [])[1] || 'image/png';
  return { buf: Buffer.from(dataUrl.slice(i + 1), 'base64'), mime };
}

let convs = 0, migratedMsgs = 0, newBlobs = 0, skipped = 0, badData = 0;
for (const row of db.listConvsForMigration()) {
  const uid: number = row.uid;
  const convId: string = row.id;
  if (db.convHasMessages(convId, uid)) { skipped++; continue; } // 幂等：已迁移则跳过
  let data: any;
  try { data = JSON.parse(row.data || '{}'); } catch { badData++; continue; }
  const messages: any[] = Array.isArray(data.messages) ? data.messages : [];
  if (!messages.length) continue;
  let seq = 0;
  for (const m of messages) {
    const msgId = 'm_' + crypto.randomBytes(8).toString('hex');
    db.insertMessage({
      id: msgId, convId, uid, seq: seq++,
      role: m.role || 'user', kind: m.kind || 'chat', model: m.model || null, text: m.text || '',
    });
    migratedMsgs++;
    const imgs: any[] = Array.isArray(m.images) ? m.images : [];
    let ord = 0;
    for (const dataUrl of imgs) {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) continue;
      try {
        const { buf, mime } = dataUrlToBuf(dataUrl);
        const hash = sha256(buf);
        if (!db.getBlobMeta(hash)) { fs.writeFileSync(path.join(BLOB_DIR, hash), buf); db.insertBlob(hash, mime, buf.length); newBlobs++; }
        db.linkBlob(msgId, hash, ord++);
      } catch (e: any) { console.warn(`  图迁移失败 conv=${convId}: ${e.message}`); }
    }
  }
  convs++;
}

console.log(`迁移完成：会话 ${convs}（跳过已迁移 ${skipped}，坏 data ${badData}）、消息 ${migratedMsgs}、新 blob ${newBlobs}`);
console.log('老 conversations.data 列已保留（可回退）。生产验证无误后，再单独清空 data 列。');
