// Electron Node mode only; writes a synthetic card to the explicitly supplied throwaway profile.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const Database = require('better-sqlite3')
const { RSSStore } = require('../../src/main/modules/database/rss-store.ts')
const { ChatStore } = require('../../src/main/modules/database/chat-store.ts')
const profile = process.argv[2]
if (!profile || !path.basename(path.dirname(profile)).startsWith('w6c-')) throw new Error('Expected capture test profile')
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const sha256 = createHash('sha256').update(bytes).digest('hex'), key = sha256 + '.png'
const db = new Database(path.join(profile, 'ready.db'))
try {
  if (process.argv[3]) {
    for (const row of JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).filter(row => row.destination === 'fastcard')) {
      const saved = JSON.parse(db.prepare('SELECT payload_json FROM fastcard_items WHERE id=?').get(row.id).payload_json)
      if (saved.text !== row.text || !saved.source.ref) throw new Error('Database readback failed: ' + row.name)
    }
  } else {
    const rss = new RSSStore(() => db)
    const source = rss.addRSSSource({ name: '收下验收资讯', url: 'https://example.invalid/feed' })
    db.prepare('UPDATE rss_sources SET enabled=0 WHERE id=?').run(source)
    rss.upsertRSSItems([{ id: 'capture-article', source_id: source, guid: 'capture-article', title: '资讯文章', link: 'https://example.invalid/article', summary: '资讯文章的完整原文：第一句，第二句。' }])
    const chat = new ChatStore(() => db)
    chat.createConversation('capture-conversation', 'butler', '收下验收对话')
    chat.addChatMessage('capture-q', 'capture-conversation', 'user', '保存这段回答', new Date().toISOString(), { runId: 'capture-run' })
    chat.addChatMessage('capture-a', 'capture-conversation', 'assistant', '助手回答的完整原文：第一句，第二句。', new Date().toISOString(), { runId: 'capture-run' })
    fs.mkdirSync(path.join(profile, 'fastcard-media'), { recursive: true })
    fs.writeFileSync(path.join(profile, 'fastcard-media', key), bytes)
    db.prepare('INSERT INTO fastcard_items(id,payload_json,position) VALUES(?,?,?)').run('fixture-image', JSON.stringify({
      id: 'fixture-image', kind: 'image', createdAt: 1, title: '验收图片', media: { status: 'cached', key, sha256, mime: 'image/png', bytes: bytes.length },
    }), 1)
  }
} finally { db.close() }
