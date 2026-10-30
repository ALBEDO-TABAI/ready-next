import { createHash } from 'node:crypto'
import type { CalendarAttachmentDisplayRef } from '../../../shared/calendar-event-identity'
import { ReadyRefSchema } from '../../../shared/ready-ref'
import { calendarEventReadyRef } from '../../../shared/calendar-event-identity'
import { toReadyUri } from '../../../shared/ready-ref'
import { CalendarStore } from '../database/calendar-store'
import type { DatabaseConnection } from '../database/connection'
import type { MigrationDatabase } from '../migrations'

interface MessageRow { id: string; conversation_id: string; content: string; timestamp: string; meta_json: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function resolveLegacyAttachment(calendar: CalendarStore, attachment: Record<string, unknown>) {
  let eventId = typeof attachment.eventId === 'string' ? attachment.eventId.trim() : ''
  let reason = ''
  if (!eventId) {
    try { eventId = decodeURIComponent(String(attachment.path).slice('calendar-event://'.length)) }
    catch { reason = '地址编码无效' }
  }
  // Never turn a timestamp placeholder into an identity without domain readback.
  if (eventId && !calendarEventReadyRef(eventId, false)) reason ||= '事件身份或原始实例格式无效'
  const event = !reason && eventId ? calendar.getCalendarEventReference(eventId) : null
  const ref = event ? calendarEventReadyRef(eventId, event.all_day === 1) : null
  return { eventId, event, ref, reason }
}

/** Only mutable user attachment metadata changes. Receipts, native history and message text stay byte-for-byte intact. */
export function migrateCalendarAttachmentReadyRefs(db: MigrationDatabase): void {
  const calendar = new CalendarStore(() => db as DatabaseConnection)
  db.exec('SAVEPOINT calendar_attachment_ready_refs')
  try {
    const rows = db.prepare(`SELECT m.id, m.conversation_id, m.content, m.timestamp, m.meta_json FROM chat_messages m
      JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.role = 'user' AND c.closed_at IS NULL AND m.meta_json LIKE '%calendar-event://%' ORDER BY m.id`).all<MessageRow>()
    for (const row of rows) {
      const meta: unknown = JSON.parse(row.meta_json)
      if (!object(meta) || !Array.isArray(meta.attachments)) continue
      let changed = false
      for (const attachment of meta.attachments) {
        if (!object(attachment) || typeof attachment.path !== 'string' || !attachment.path.startsWith('calendar-event://')) continue
        changed = true
        const { eventId, event, ref, reason: unresolvedReason } = resolveLegacyAttachment(calendar, attachment)
        let reason = unresolvedReason
        if (ref) {
          attachment.path = toReadyUri(ref)
          attachment.eventId = eventId
          attachment.allDay = event!.all_day === 1
          attachment.source = 'calendar-event'
        } else {
          reason ||= eventId ? '真实事件或原始实例不存在' : '缺少事件身份'
          attachment.calendarReferenceMigration = { status: 'unlocatable', reason, originalPath: attachment.path, originalEventId: attachment.eventId ?? null }
          attachment.path = ''
          delete attachment.eventId
          attachment.source = 'calendar-event'
          attachment.name = `${String(attachment.name || '日程')}（无法定位）`
          attachment.description = `无法定位：${reason}。${typeof attachment.description === 'string' ? attachment.description : ''}`
        }
      }
      if (!changed) continue
      db.prepare('UPDATE chat_messages SET meta_json = ? WHERE id = ? AND meta_json = ?').run(JSON.stringify(meta), row.id, row.meta_json)
      if (db.prepare('SELECT changes() n').get<{n:number}>()!.n !== 1) throw new Error('calendar attachment migration row count mismatch')
      db.prepare('DELETE FROM session_recall_attachment_index WHERE source_message_id = ?').run(row.id)
      for (const [index, attachment] of meta.attachments.entries()) {
        if (!object(attachment)) continue
        const id = String(attachment.id || `${row.id}-${index}`).trim()
        const name = String(attachment.name || '').trim(), path = String(attachment.path || '').trim()
        if (!id || !name) continue
        db.prepare(`INSERT OR REPLACE INTO session_recall_attachment_index
          (attachment_key,conversation_id,attachment_id,source_message_id,name,type,ext,path,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(`${row.conversation_id}::${id}::${path || name}`, row.conversation_id, id, row.id, name, attachment.type || null, attachment.ext || null, path || null, row.timestamp)
      }
      db.prepare('DELETE FROM chat_messages_fts WHERE message_id = ?').run(row.id)
      db.prepare('INSERT INTO chat_messages_fts(message_id,conversation_id,content) VALUES (?,?,?)').run(row.id, row.conversation_id, row.content)
    }
    db.exec('RELEASE calendar_attachment_ready_refs')
  } catch (error) {
    db.exec('ROLLBACK TO calendar_attachment_ready_refs')
    db.exec('RELEASE calendar_attachment_ready_refs')
    throw error
  }
}

const attachmentDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Separate display projection: the immutable message and native history never change. */
export function migrateCalendarAttachmentDisplayRefs(db: MigrationDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_attachment_display_refs (
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    attachment_index INTEGER NOT NULL CHECK(attachment_index >= 0),
    original_digest TEXT NOT NULL,
    ready_ref_json TEXT,
    reason TEXT,
    CHECK((ready_ref_json IS NOT NULL AND reason IS NULL) OR (ready_ref_json IS NULL AND reason IS NOT NULL)),
    PRIMARY KEY(message_id, attachment_index)
  )`)
  db.exec('SAVEPOINT calendar_display_refs')
  try {
    const calendar = new CalendarStore(() => db as DatabaseConnection)
    const rows = db.prepare(`SELECT m.id, m.meta_json FROM chat_messages m
      JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.role = 'user' AND c.closed_at IS NOT NULL AND m.meta_json LIKE '%calendar-event://%' ORDER BY m.id`).all<{id:string;meta_json:string}>()
    for (const row of rows) {
      const meta: unknown = JSON.parse(row.meta_json)
      if (!object(meta) || !Array.isArray(meta.attachments)) continue
      for (const [index, attachment] of meta.attachments.entries()) {
        if (!object(attachment) || typeof attachment.path !== 'string' || !attachment.path.startsWith('calendar-event://')) continue
        if (db.prepare('SELECT 1 FROM calendar_attachment_display_refs WHERE message_id=? AND attachment_index=?').get(row.id, index)) continue
        const { ref, reason, eventId } = resolveLegacyAttachment(calendar, attachment)
        db.prepare(`INSERT INTO calendar_attachment_display_refs
          (message_id, attachment_index, original_digest, ready_ref_json, reason) VALUES (?,?,?,?,?)`)
          .run(row.id, index, attachmentDigest(attachment), ref ? JSON.stringify(ref) : null,
            ref ? null : reason || (eventId ? '真实事件或原始实例不存在' : '缺少事件身份'))
      }
    }
    db.exec('RELEASE calendar_display_refs')
  } catch (error) {
    db.exec('ROLLBACK TO calendar_display_refs')
    db.exec('RELEASE calendar_display_refs')
    throw error
  }
}

/** Reads only migrated display mappings; it never interprets a legacy URI at runtime. */
export function readCalendarAttachmentDisplayRefs(db: MigrationDatabase, messageIds: string[]): CalendarAttachmentDisplayRef[] {
  const result: CalendarAttachmentDisplayRef[] = []
  for (const id of new Set(messageIds)) {
    const rows = db.prepare(`SELECT d.*, m.meta_json FROM calendar_attachment_display_refs d
      JOIN chat_messages m ON m.id=d.message_id JOIN chat_conversations c ON c.id=m.conversation_id
      WHERE d.message_id=? AND c.closed_at IS NOT NULL ORDER BY d.attachment_index`).all<{
        message_id:string;attachment_index:number;original_digest:string;ready_ref_json:string|null;reason:string|null;meta_json:string
      }>(id)
    for (const row of rows) {
      const meta: unknown = JSON.parse(row.meta_json)
      if (!object(meta) || !Array.isArray(meta.attachments) || row.attachment_index >= meta.attachments.length
        || attachmentDigest(meta.attachments[row.attachment_index]) !== row.original_digest) throw new Error('历史附件原值摘要不匹配')
      const ref = row.ready_ref_json ? ReadyRefSchema.parse(JSON.parse(row.ready_ref_json)) : null
      if (ref && ref.kind !== 'event') throw new Error('历史日程展示引用类型无效')
      result.push({ messageId: row.message_id, attachmentIndex: row.attachment_index,
        target: ref ? { status: 'resolved', ref } : { status: 'unlocatable', reason: row.reason! } })
    }
  }
  return result
}
