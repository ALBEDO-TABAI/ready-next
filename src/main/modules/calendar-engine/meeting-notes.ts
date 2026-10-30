import { MeetingNoteInputSchema, type MeetingNoteInput, type MeetingNoteReceipt } from '../../../shared/calendar/event-links'
import { findCalendarOccurrence, splitOccurrenceKey } from '../../../shared/calendar/commands'
import { toReadyUri } from '../../../shared/ready-ref'
import type { DatabaseConnection } from '../database/connection'
import type { CalendarStore } from '../database/calendar-store'
import type { DocumentDraftService } from '../document-drafts/service'
import type { DraftFinalizeInput } from '../../../shared/document-drafts'
import { objectTransaction } from '../object-service/registry'

interface Intent { event_key:string; vault_root:string; draft_id:string; destination_json:string; state:'prepared'|'linked'; receipt_json:string|null }

/** One durable intention per event/instance; finalization owns file publication and recovery. */
export class CalendarMeetingNotes {
  private readonly pending = new Map<string, {input:string;promise:Promise<MeetingNoteReceipt>}>()
  constructor(private readonly db:DatabaseConnection, private readonly calendar:CalendarStore, private readonly drafts:DocumentDraftService) {}

  pendingDestination(root:string,key:string):DraftFinalizeInput|null {
    if (typeof key !== 'string' || !key) throw new Error('日程身份无效')
    const [id,original] = splitOccurrenceKey(key)
    const eventKey = toReadyUri({kind:'event',id,...(original===undefined?{}:{occurrence:original})})
    const row = this.db.prepare("SELECT * FROM calendar_meeting_note_intents WHERE event_key=? AND state='prepared'").get<Intent>(eventKey)
    if (!row) return null
    if (row.vault_root !== root) throw new Error('会议笔记属于其他资料库')
    return MeetingNoteInputSchema.shape.destination.parse(JSON.parse(row.destination_json))
  }

  create(root:string, input:MeetingNoteInput):Promise<MeetingNoteReceipt> {
    const parsed = MeetingNoteInputSchema.parse(input), signature = JSON.stringify([root,parsed])
    const pending = this.pending.get(parsed.key)
    if (pending) {
      if (pending.input !== signature) return Promise.reject(new Error('会议笔记创建意图正在处理中'))
      return pending.promise
    }
    const promise = this.createOnce(root,parsed).finally(()=>this.pending.delete(parsed.key))
    this.pending.set(parsed.key,{input:signature,promise})
    return promise
  }

  private async createOnce(root:string, input:MeetingNoteInput):Promise<MeetingNoteReceipt> {
    const snapshot = this.calendar.snapshot(), occurrence = findCalendarOccurrence(snapshot.events,input.key)
    if (!occurrence) throw new Error('日程已变化或不存在')
    const eventId = occurrence.seriesId || occurrence.event.id, original = splitOccurrenceKey(input.key)[1]
    const source = {kind:'event' as const,id:eventId,...(original===undefined?{}:{occurrence:original})}
    const eventKey = toReadyUri(source)
    let intent = this.db.prepare('SELECT * FROM calendar_meeting_note_intents WHERE event_key=?').get<Intent>(eventKey)
    if (intent && (intent.vault_root !== root || intent.destination_json !== JSON.stringify(input.destination))) throw new Error('会议笔记已有创建意图，请继续原保存位置')
    if (intent?.state === 'linked') {
      const result:MeetingNoteReceipt = JSON.parse(intent.receipt_json!)
      if (!snapshot.links?.some(link=>link.eventId===eventId && String(link.originalStart)===String(original) && link.purpose==='meeting-note' && toReadyUri(link.target)===toReadyUri(result.ref))) throw new Error('会议笔记关联已撤销或变化')
      return result
    }
    // Check before publishing any file, then CalendarStore checks again after asynchronous finalization.
    const calendar = snapshot.calendars.find(item=>item.id===occurrence.event.calendarId)
    if (!calendar || calendar.readOnly || calendar.syncUrl) throw new Error('订阅日历为只读，不能创建会议笔记')
    if (snapshot.events.find(event=>event.id===eventId)?.revision !== input.expected[eventId]) throw new Error('日程版本已变化，请刷新后重试')
    if (snapshot.links?.some(link=>link.eventId===eventId && String(link.originalStart)===String(original) && link.purpose==='meeting-note')) throw new Error('该日程已有会议笔记')
    if (!intent) intent = objectTransaction(this.db,()=>{
      const draft = this.drafts.create({vaultRoot:root,origin:'new',title:input.destination.title,
        content:`# ${input.destination.title}\n\n[日程](${toReadyUri(source)})\n\n`})
      this.db.prepare("INSERT INTO calendar_meeting_note_intents(event_key,vault_root,draft_id,destination_json,state) VALUES (?,?,?,?,'prepared')")
        .run(eventKey,root,draft.draftId,JSON.stringify(input.destination))
      return this.db.prepare('SELECT * FROM calendar_meeting_note_intents WHERE event_key=?').get<Intent>(eventKey)!
    })
    const draft = this.drafts.read(intent.draft_id)
    if (!draft) throw new Error('会议笔记草稿不存在')
    const saved = await this.drafts.finalize(draft.draftId,draft.revision,input.destination)
    const ref = {kind:'page' as const,id:saved.objectId}
    // Persist the receipt in the same CalendarStore transaction, so notification follows durable completion.
    return this.calendar.linkMeetingNote(input.key, ref, input.expected, result => {
      this.db.prepare("UPDATE calendar_meeting_note_intents SET state='linked',receipt_json=? WHERE event_key=?")
        .run(JSON.stringify(result),eventKey)
    })
  }
}
