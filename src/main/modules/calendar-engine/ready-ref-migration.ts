import { calendarEventReadyRef } from '../../../shared/calendar-event-identity'
import { toReadyUri } from '../../../shared/ready-ref'
import { CalendarStore } from '../database/calendar-store'
import type { DatabaseConnection } from '../database/connection'
import type { MigrationDatabase } from '../migrations'

interface MessageRow { id: string; conversation_id: string; content: string; timestamp: string; meta_json: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

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
        let eventId = typeof attachment.eventId === 'string' ? attachment.eventId.trim() : ''
        let reason = ''
        if (!eventId) {
          try { eventId = decodeURIComponent(attachment.path.slice('calendar-event://'.length)) }
          catch { reason = '地址编码无效' }
        }
        // Never turn a timestamp placeholder into an identity without domain readback.
        if (eventId && !calendarEventReadyRef(eventId, false)) reason ||= '事件身份或原始实例格式无效'
        const event = !reason && eventId ? calendar.getCalendarEventReference(eventId) : null
        const ref = event ? calendarEventReadyRef(eventId, event.all_day === 1) : null
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
