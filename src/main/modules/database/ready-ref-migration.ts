import { createHash } from 'node:crypto'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'
import { RSSReferenceSchema, rssReferencePath, type RSSReference } from '../../../shared/rss-reference'
import { toReadyUri } from '../../../shared/ready-ref'
import type { MigrationDatabase } from '../migrations'
import type { DatabaseConnection } from './connection'
import { RSSStore } from './rss-store'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const legacy = /^(?:browser-tab|doc-tab|document-quote|ready-rss|rss-reference):\/\//
interface Row { id:string;role:string;conversation_id:string;timestamp:string;content:string;meta_json:string|null;closed_at:string|null }
interface Display { content?: string; attachments?: Record<string, unknown>[]; issues: string[] }

function decodeRSS(path: string): RSSReference {
  if (path.startsWith('rss-reference://')) return RSSReferenceSchema.parse(JSON.parse(decodeURIComponent(path.slice('rss-reference://'.length))))
  const url = new URL(path)
  if (url.protocol !== 'ready-rss:' || url.hostname !== 'reference' || url.username || url.password || url.port
    || (url.pathname && url.pathname !== '/') || url.hash || [...url.searchParams.keys()].join() !== 'data') throw new Error('RSS 引用地址无效')
  return RSSReferenceSchema.parse(JSON.parse(url.searchParams.get('data') || ''))
}

function checkRSS(rss: RSSStore, reference: RSSReference): void {
  if (reference.kind === 'article') rss.content.readArticle(reference.read)
  else if (reference.kind === 'excerpt') rss.content.readExcerpt(reference.read)
  else if (reference.kind === 'digest') rss.digests.read({ view: 'entries', ...reference.read })
  else rss.content.query(reference.query)
}

function migrateAttachment(db: MigrationDatabase, rss: RSSStore, original: Record<string, unknown>): { attachment: Record<string, unknown>; reason?: string } | null {
  const path = typeof original.path === 'string' ? original.path : ''
  const document = original.source === 'document-tab' || original.source === 'document-quote'
  if (!legacy.test(path) && !(document && path && !path.startsWith('ready://'))) return null
  const attachment = { ...original }
  // A saved browser URL is navigation, never a resurrected live tab capability.
  delete attachment.browserTabId
  try {
    if (path.startsWith('browser-tab://')) {
      if (typeof original.url !== 'string') throw new Error('缺少可信网页 URL，不能从旧标签身份恢复')
      attachment.path = toReadyUri({ kind: 'web', url: original.url })
      attachment.source = 'browser-tab'
    } else if (original.source === 'rss-reference' || /^(ready-rss|rss-reference):/.test(path)) {
      const reference = original.rssReference === undefined ? decodeRSS(path) : RSSReferenceSchema.parse(original.rssReference)
      checkRSS(rss, reference)
      attachment.path = rssReferencePath(reference)
      attachment.rssReference = reference
      attachment.source = 'rss-reference'
    } else {
      attachment.source = original.source === 'document-quote' || path.startsWith('document-quote://') ? 'document-quote' : 'document-tab'
      const row = db.prepare("SELECT id,kind FROM objects WHERE current_path=? AND status='present' AND identity_state<>'conflict'")
        .get<{id:string;kind:string}>(path)
      if (!row || !['markdown', 'file'].includes(row.kind)) throw new Error('没有可核实的文档对象身份；保留引用原文')
      attachment.path = toReadyUri({ kind: row.kind === 'markdown' ? 'page' : 'file', id: row.id })
    }
    return { attachment }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    attachment.path = ''
    attachment.description = `无法定位：${reason}`
    attachment.referenceMigration = { originalPath: path, reason }
    return { attachment, reason }
  }
}

/** Only actual link nodes and bare URI tokens; inline/fenced code and ordinary prose stay intact. */
function migrateContent(content: string, rss: RSSStore): { content: string; issues: string[] } {
  const patches: Array<{ start:number;end:number;text:string }> = [], issues: string[] = []
  const convert = (href: string): string | null => {
    try {
      if (!/^(ready-rss|rss-reference):/.test(href)) throw new Error('历史链接缺少结构化来源，无法定位')
      const reference = decodeRSS(href); checkRSS(rss, reference)
      return rssReferencePath(reference)
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error)); return null
    }
  }
  const visit = (node: Nodes) => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') return
    const start = node.position?.start.offset, end = node.position?.end.offset
    if (node.type === 'link' && legacy.test(node.url) && start !== undefined && end !== undefined) {
      const next = convert(node.url), raw = content.slice(start, end)
      const urlStart = raw.lastIndexOf(node.url)
      // Escaped destinations may differ from the AST URL; preserve the label and explicitly disable navigation.
      patches.push({ start, end, text: next && urlStart >= 0 ? raw.slice(0, urlStart) + next + raw.slice(urlStart + node.url.length)
        : node.children.map(child => 'value' in child ? child.value : '').join('') + '（无法定位）' })
      return
    }
    if (node.type === 'text' && start !== undefined && end !== undefined) {
      const raw = content.slice(start, end)
      for (const match of raw.matchAll(/(?:ready-rss|rss-reference):\/\/[^\s<>"'`]+/g)) {
        const next = convert(match[0]); patches.push({ start: start + match.index, end: start + match.index + match[0].length, text: next || '（RSS 引用无法定位）' })
      }
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(fromMarkdown(content))
  for (const patch of patches.sort((a, b) => b.start - a.start)) content = content.slice(0, patch.start) + patch.text + content.slice(patch.end)
  return { content, issues }
}

/** Immutable text and closed-scope attachments are projected, never rewritten. No receipt/native-history tables are touched. */
export function migrateChatReadyRefs(db: MigrationDatabase): void {
  db.exec('SAVEPOINT chat_ready_refs')
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_ready_ref_display (
      message_id TEXT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
      content_digest TEXT NOT NULL, attachments_digest TEXT NOT NULL,
      display_json TEXT NOT NULL
    )`)
    const rss = new RSSStore(() => db as DatabaseConnection)
    const rows = db.prepare(`SELECT m.*,c.closed_at FROM chat_messages m JOIN chat_conversations c ON c.id=m.conversation_id
      WHERE m.role IN ('user','assistant') ORDER BY m.id`).all<Row>()
    for (const row of rows) {
      if (db.prepare('SELECT 1 FROM chat_ready_ref_display WHERE message_id=?').get(row.id)) continue
      const meta: unknown = row.meta_json ? JSON.parse(row.meta_json) : {}
      if (!object(meta)) throw new Error(`消息附件结构无效：${row.id}`)
      const original = Array.isArray(meta.attachments) ? meta.attachments : []
      let changed = false
      const issues: string[] = []
      const attachments = original.map(value => {
        if (!object(value) || row.role !== 'user') return value
        const result = migrateAttachment(db, rss, value)
        if (!result) return value
        changed = true
        if (result.reason) issues.push(result.reason)
        return result.attachment
      })
      const text = migrateContent(row.content, rss)
      if (!changed && text.content === row.content) continue
      if (changed && row.closed_at === null) {
        meta.attachments = attachments
        db.prepare('UPDATE chat_messages SET meta_json=? WHERE id=? AND meta_json IS ?').run(JSON.stringify(meta), row.id, row.meta_json)
        if (db.prepare('SELECT changes() n').get<{n:number}>()!.n !== 1) throw new Error('聊天附件迁移写入数量不符')
        db.prepare('DELETE FROM session_recall_attachment_index WHERE source_message_id=?').run(row.id)
        for (const [index, attachment] of attachments.entries()) {
          if (!object(attachment)) continue
          const id = String(attachment.id || `${row.id}-${index}`), name = String(attachment.name || ''), path = String(attachment.path || '')
          if (!id || !name) continue
          db.prepare(`INSERT OR REPLACE INTO session_recall_attachment_index
            (attachment_key,conversation_id,attachment_id,source_message_id,name,type,ext,path,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(`${row.conversation_id}::${id}::${path || name}`, row.conversation_id, id, row.id, name, attachment.type || null, attachment.ext || null, path || null, row.timestamp)
        }
        db.prepare('DELETE FROM chat_messages_fts WHERE message_id=?').run(row.id)
        db.prepare('INSERT INTO chat_messages_fts(message_id,conversation_id,content) VALUES (?,?,?)').run(row.id, row.conversation_id, row.content)
      }
      const display = { ...(text.content !== row.content ? { content: text.content } : {}),
        ...(changed && row.closed_at !== null ? { attachments } : {}), issues: [...issues, ...text.issues] }
      db.prepare('INSERT INTO chat_ready_ref_display(message_id,content_digest,attachments_digest,display_json) VALUES (?,?,?,?)')
        .run(row.id, digest(row.content), digest(meta.attachments || []), JSON.stringify(display))
    }
    db.exec('RELEASE chat_ready_refs')
  } catch (error) {
    db.exec('ROLLBACK TO chat_ready_refs'); db.exec('RELEASE chat_ready_refs'); throw error
  }
}

/** Runtime reads only a digest-bound projection; no legacy URI parsing occurs here. */
export function readChatReadyRefDisplay(db: MigrationDatabase, messageId: string): Display | null {
  const row = db.prepare(`SELECT d.*,m.content,m.meta_json FROM chat_ready_ref_display d JOIN chat_messages m ON m.id=d.message_id WHERE d.message_id=?`)
    .get<{content_digest:string;attachments_digest:string;display_json:string;content:string;meta_json:string|null}>(messageId)
  if (!row) return null
  const meta: unknown = row.meta_json ? JSON.parse(row.meta_json) : {}
  if (!object(meta) || digest(row.content) !== row.content_digest || digest(meta.attachments || []) !== row.attachments_digest) throw new Error('历史引用原值摘要不匹配')
  const display: unknown = JSON.parse(row.display_json)
  if (!object(display) || !Array.isArray(display.issues) || !display.issues.every(item => typeof item === 'string')
    || (display.content !== undefined && typeof display.content !== 'string')
    || (display.attachments !== undefined && (!Array.isArray(display.attachments) || !display.attachments.every(object)))) throw new Error('历史引用展示映射无效')
  return { ...(typeof display.content === 'string' ? { content: display.content } : {}),
    ...(Array.isArray(display.attachments) ? { attachments: display.attachments.filter(object) } : {}), issues: display.issues }
}
