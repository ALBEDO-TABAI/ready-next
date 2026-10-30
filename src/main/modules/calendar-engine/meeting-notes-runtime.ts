import { app } from 'electron'
import { getDatabase } from '../database'
import { ObjectRegistry } from '../object-service/registry'
import { DocumentDraftService } from '../document-drafts/service'
import { CalendarMeetingNotes } from './meeting-notes'
import type { MeetingNoteInput } from '../../../shared/calendar/event-links'

/** Construct at startup, alongside the other draft users, before any finalization can be active. */
export function createCalendarMeetingNotesRuntime() {
  const database = getDatabase(), db = database.getRawDb()
  if (!db) throw new Error('会议笔记数据库不可用')
  const drafts = new DocumentDraftService(db, { registry: new ObjectRegistry(db), index: async (root,path) => {
    const { getSearchEngine } = await import('../search-engine/ipc-handler')
    const search = getSearchEngine()
    if (!search) throw new Error('文档索引尚未就绪')
    search.getRepository().ensureWorkspace(root)
    const result = await search.indexDocument(root,path)
    if (!result.ok) throw new Error(result.error || '会议笔记索引失败')
  } })
  const notes = new CalendarMeetingNotes(db,database.calendar,drafts)
  const root = async () => {
    const { VaultService } = await import('../settings-engine/vault-service')
    const { AppSettingsRepository } = await import('../repositories/app-settings-repository')
    const vault = new VaultService(new AppSettingsRepository(), {home:app.getPath('home'),userData:app.getPath('userData'),isPackaged:app.isPackaged}).get()
    if (vault.status !== 'ready') throw new Error('请先配置可用的资料库')
    return vault.root
  }
  return { create:async (input:MeetingNoteInput)=>notes.create(await root(),input),
    pending:async (key:string)=>notes.pendingDestination(await root(),key) }
}
