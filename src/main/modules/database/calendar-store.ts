import { createHash } from 'node:crypto'
import type { DatabaseConnection } from './connection'
import { SettingsStore } from './settings-store'
import type { CalendarSource, CalendarEvent, EventInstance, EventOverride } from './records'
import { occurrences, newId, isRecurring, type CalEvent, type Calendar } from '../../../shared/calendar/model'
import { planCalendarMutation, findCalendarOccurrence, type CalendarCommand, type CalendarDelta, type CalendarSnapshot, type CalendarMutationReceipt } from '../../../shared/calendar/commands'
import { validateCalendarEvent } from '../../../shared/calendar/validation'
import { importIcs, exportIcs } from '../../../shared/calendar/ics'
import { dayOf, startOfDayMs, systemTimeZone } from '../../../shared/calendar/tz'
import { isoDate } from '../../../shared/calendar/dates'
import { decodeCalendarRow, encodeCalendarEvent, calendarEventToRecord, originalFromSeconds, originalToSeconds, type CalendarRow } from '../calendar-engine/calendar-row-codec'
import { publishCalendarChanged } from '../calendar-engine/calendar-change'

const PREFS_KEY = 'calendar_preferences_v1'
const versionsOf = (events: CalEvent[]) => Object.fromEntries(events.map(e => [e.id, e.revision || 1]))
const importedId = (source: string, uid: string) => `ics-${source}-${createHash('md5').update(uid).digest('hex').slice(0,12)}`

/** The single database owner for UI, product actions, subscriptions and reminders. */
export class CalendarStore {
  private readonly settings: SettingsStore
  constructor(private readonly getConnection: () => DatabaseConnection | null) { this.settings = new SettingsStore(getConnection) }
  private get db(): DatabaseConnection { const db = this.getConnection(); if (!db) throw new Error('日历数据库不可用'); return db }

  snapshot(): CalendarSnapshot {
    const sources = this.db.prepare('SELECT * FROM calendar_sources ORDER BY position,created_at,id').all<CalendarRow>()
    const setting = this.db.prepare('SELECT value FROM settings WHERE key=?').get<{value:string}>(PREFS_KEY)
    const prefs = setting ? JSON.parse(setting.value) as Record<string, unknown> : {}
    const primary = String(prefs.defaultCalendarId || sources.find(s => !s.sync_url && s.enabled)?.id || sources.find(s=>!s.sync_url)?.id || '')
    const calendars: Calendar[] = sources.map(s => ({id:String(s.id),accountId:s.sync_url?'subscriptions':'local',name:String(s.name),color:String(s.color),visible:!!s.visible,primary:s.id===primary,readOnly:!!s.sync_url,order:Number(s.position),timeZone:s.time_zone?String(s.time_zone):undefined,syncUrl:s.sync_url?String(s.sync_url):null,syncInterval:Number(s.sync_interval),syncEnabled:!!s.enabled,revision:Number(s.revision),syncError:s.sync_error?String(s.sync_error):null,lastSyncedAt:s.last_synced_at?Number(s.last_synced_at):null}))
    const rows = this.db.prepare('SELECT * FROM calendar_events ORDER BY created_at,id').all<CalendarRow>()
    const events = rows.map(decodeCalendarRow), parents = new Map(events.map(e=>[e.id,e])), raw = new Map(rows.map(r=>[String(r.id),r]))
    for (const override of this.db.prepare('SELECT * FROM calendar_event_overrides ORDER BY occurrence_start').all<CalendarRow>()) {
      const parent = parents.get(String(override.parent_event_id)); if (!parent) throw new Error('日历例外缺少母事件')
      if (!isRecurring(parent)) continue
      const originalStart = originalFromSeconds(Number(override.occurrence_start),parent.allDay)
      if (override.kind !== 'single') continue
      const patch = override.patch_json ? JSON.parse(String(override.patch_json)) as CalendarRow : {}
      const base = raw.get(parent.id)!
      const start = parent.allDay ? isoDate(Number(override.occurrence_start)/86400) : Number(override.occurrence_start)
      const duration = parent.allDay ? (Date.parse(String(parent.end))-Date.parse(String(parent.start)))/86400000 : (Number(parent.end)-Number(parent.start))/1000
      const occurrenceRow = {...base, ...(parent.allDay ? {start_date:start,end_date:isoDate(Number(override.occurrence_start)/86400+duration)} : {start_time:start,end_time:Number(start)+duration}), ...patch, id:override.id,recurrence_rule:null,created_at:override.created_at,updated_at:override.updated_at,revision:parent.revision}
      events.push({...decodeCalendarRow(occurrenceRow),uid:parent.uid,rrule:undefined,exdates:undefined,rdates:undefined,recurringEventId:parent.id,originalStart})
    }
    return {calendars,events,prefs}
  }

  private pendingChange = false
  private pendingIds = new Set<string>()
  private changed(ids:readonly string[]):void {
    if(this.db.inTransaction){this.pendingChange=true;ids.forEach(id=>this.pendingIds.add(id));return}
    publishCalendarChanged(ids)
  }
  private transaction<T>(body:()=>T):T {
    const own = !this.db.inTransaction
    if (own) this.db.exec('BEGIN IMMEDIATE')
    try {const result=body();if(own){this.db.exec('COMMIT');if(this.pendingChange){const ids=[...this.pendingIds];this.pendingChange=false;this.pendingIds.clear();publishCalendarChanged(ids)}}return result}
    catch(error){if(own){this.db.exec('ROLLBACK');this.pendingChange=false;this.pendingIds.clear()}throw error}
  }
  private writable(id:string, calendars:Calendar[]) {
    const cal=calendars.find(c=>c.id===id)
    if(!cal)throw new Error('日历不存在')
    if(cal.readOnly)throw new Error('订阅日历为只读，请复制到本地日历后修改')
  }
  mutate(command:CalendarCommand, expected:Record<string,number>):CalendarMutationReceipt {
    return this.commit(planCalendarMutation(this.snapshot(),command),expected)
  }
  restore(delta:CalendarDelta,expected:Record<string,number>):CalendarMutationReceipt { return this.commit(delta,expected) }

  private commit(delta:CalendarDelta,expected:Record<string,number>, importedSource?:string):CalendarMutationReceipt {return this.transaction(()=>this.commitInside(delta,expected,importedSource))}
  private commitInside(delta:CalendarDelta,expected:Record<string,number>, importedSource?:string):CalendarMutationReceipt {
    const before=this.snapshot(), old=new Map(before.events.map(e=>[e.id,e]))
    const put=delta.put.map(validateCalendarEvent), remove=[...new Set(delta.remove)]
    for(const event of put.filter(e=>e.recurringEventId)){const conflict=before.events.find(e=>e.recurringEventId===event.recurringEventId&&String(e.originalStart)===String(event.originalStart)&&e.id!==event.id);if(conflict&&!put.some(e=>e.id===conflict.id)&&!remove.includes(conflict.id))remove.push(conflict.id)}
    const targets=new Set([...put.map(e=>e.id),...remove])
    for(const e of put)if(e.recurringEventId)targets.add(e.recurringEventId)
    for(const id of remove){const e=old.get(id);if(e?.recurringEventId)targets.add(e.recurringEventId)}
    for(const id of targets){
      const current=old.get(id)
      if(current && expected[id]!==current.revision)throw new Error('日程版本已变化，请刷新后重试')
      if(!current && (expected[id] || 0)!==0)throw new Error('日程已被删除，请刷新后重试')
      if(current && !importedSource)this.writable(current.calendarId,before.calendars)
    }
    const future=new Map(old)
    remove.forEach(id=>future.delete(id));put.forEach(e=>future.set(e.id,e))
    for(const e of put){
      if(importedSource){if(e.calendarId!==importedSource)throw new Error('导入日历不匹配')}
      else this.writable(e.calendarId,before.calendars)
      if(e.recurringEventId && !future.has(e.recurringEventId))throw new Error('重复日程缺少母事件')
      if(e.recurringEventId&&typeof e.originalStart!==(future.get(e.recurringEventId)!.allDay?'string':'number'))throw new Error('重复实例的原日期类型与母事件不一致')
    }
    const undo:CalendarDelta={put:[...targets].map(id=>old.get(id)).filter((e):e is CalEvent=>!!e),remove:put.filter(e=>!old.has(e.id)).map(e=>e.id)}
    this.transaction(()=>{
      for(const id of remove){this.db.prepare('DELETE FROM calendar_event_overrides WHERE id=?').run(id);this.db.prepare('DELETE FROM calendar_event_overrides WHERE parent_event_id=?').run(id);this.db.prepare('DELETE FROM calendar_events WHERE id=?').run(id)}
      for(const event of put.filter(e=>e.recurringEventId))this.db.prepare('DELETE FROM calendar_event_overrides WHERE id=?').run(event.id)
      for(const e of put.filter(e=>!e.recurringEventId)){
        const record=encodeCalendarEvent(e), keys=Object.keys(record)
        const revision=(old.get(e.id)?.revision ?? e.revision ?? 0)+1
        this.db.prepare(`INSERT INTO calendar_events(${keys.join(',')},revision,source_id) VALUES (${keys.map(()=>'?').join(',')},?,?) ON CONFLICT(id) DO UPDATE SET ${keys.filter(k=>k!=='id'&&k!=='created_at').map(k=>`${k}=excluded.${k}`).join(',')},revision=excluded.revision`).run(...keys.map(k=>record[k]),revision,importedSource || null)

      }
      for(const e of put.filter(e=>e.recurringEventId)){
        const parent=future.get(e.recurringEventId!)!, record=encodeCalendarEvent(e), parentRecord=encodeCalendarEvent(parent)
        const patch:CalendarRow={}
        for(const [k,v]of Object.entries(record))if(!['id','ics_uid','recurrence_rule','rdates','created_at','updated_at'].includes(k) && (['start_time','end_time','start_date','end_date'].includes(k)||JSON.stringify(v)!==JSON.stringify(parentRecord[k])))patch[k]=v
        this.db.prepare("INSERT INTO calendar_event_overrides(id,parent_event_id,occurrence_start,kind,patch_json) VALUES (?,?,?,'single',?) ON CONFLICT(parent_event_id,occurrence_start) DO UPDATE SET id=excluded.id,kind='single',patch_json=excluded.patch_json,updated_at=unixepoch()").run(e.id,e.recurringEventId,originalToSeconds(e.originalStart!),JSON.stringify(patch))
      }
      for(const id of targets)if(old.has(id)&&!put.some(e=>e.id===id)&&!remove.includes(id))this.db.prepare('UPDATE calendar_events SET revision=revision+1,updated_at=unixepoch() WHERE id=?').run(id)
    })
    const snapshot=this.snapshot(), now=versionsOf(snapshot.events)
    for(const id of targets)if(!(id in now))now[id]=0
    this.changed([...targets])
    return {snapshot,undo,versions:now,changedIds:[...targets]}
  }

  savePreferences(prefs:Record<string,unknown>):void {
    this.settings.setSetting(PREFS_KEY,JSON.stringify({...this.snapshot().prefs,...prefs}));this.changed([])
  }
  putCalendars(calendars:Calendar[]):void {this.transaction(()=>calendars.forEach(calendar=>this.putCalendar(calendar)))}
  putCalendar(calendar:Calendar):void {
    if(!calendar.id || !calendar.name.trim() || !/^#[0-9a-f]{6}$/i.test(calendar.color))throw new Error('日历名称或颜色无效')
    const current=this.getCalendarSourceById(calendar.id) as (CalendarSource&{revision?:number})|null
    if(current && calendar.revision!==undefined && calendar.revision!==current.revision)throw new Error('日历版本已变化')
    this.transaction(()=>{
      this.db.prepare(`INSERT INTO calendar_sources(id,name,color,visible,position,time_zone) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,visible=excluded.visible,position=excluded.position,time_zone=excluded.time_zone,revision=calendar_sources.revision+1`).run(calendar.id,calendar.name.trim(),calendar.color,calendar.visible?1:0,calendar.order||0,calendar.timeZone||null)
      if(calendar.primary){const prefs=this.snapshot().prefs || {};this.settings.setSetting(PREFS_KEY,JSON.stringify({...prefs,defaultCalendarId:calendar.id}))}
    });this.changed([calendar.id])
  }
  getSources():CalendarSource[]{return this.getCalendarSources()}
  getCalendarSources():CalendarSource[]{return this.db.prepare('SELECT * FROM calendar_sources ORDER BY position,created_at').all<CalendarSource>()}
  getCalendarSourceById(id:string):CalendarSource|null{return this.db.prepare('SELECT * FROM calendar_sources WHERE id=?').get<CalendarSource>(id)||null}
  addCalendarSource(source:{name:string;color:string}):string{const id=newId('cal');this.putCalendar({id,accountId:'local',...source,visible:true});return id}
  upsertCalendarSource(source:{id:string;name:string;color?:string;type?:string;syncUrl?:string|null;syncInterval?:number;enabled?:boolean}):{id:string;action:'created'|'updated'}{
    const old=this.getCalendarSourceById(source.id)
    this.db.prepare(`INSERT INTO calendar_sources(id,name,color,type,sync_url,sync_interval,enabled) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,type=excluded.type,sync_url=excluded.sync_url,sync_interval=excluded.sync_interval,enabled=excluded.enabled,revision=calendar_sources.revision+1`).run(source.id,source.name,source.color||old?.color||'#4CA8DF',source.type||old?.type||'local',source.syncUrl===undefined?old?.sync_url||null:source.syncUrl,source.syncInterval||old?.sync_interval||60,source.enabled===undefined?(old?.enabled??1):source.enabled?1:0)
    this.changed([source.id]);return {id:source.id,action:old?'updated':'created'}
  }
  deleteCalendarSource(id:string):{deleted:boolean}{
    const exists=this.getCalendarSourceById(id);if(!exists)return {deleted:false}
    const snapshot=this.snapshot();if(!exists.sync_url&&snapshot.calendars.filter(c=>!c.readOnly).length<=1)throw new Error('请至少保留一个本地日历')
    this.transaction(()=>{this.db.prepare('DELETE FROM calendar_event_overrides WHERE parent_event_id IN (SELECT id FROM calendar_events WHERE calendar_id=?)').run(id);this.db.prepare('DELETE FROM calendar_events WHERE calendar_id=?').run(id);this.db.prepare('DELETE FROM calendar_sources WHERE id=?').run(id)})
    this.changed([id]);return {deleted:true}
  }

  getCalendarEventReference(id:string):CalendarEvent|null {
    const [parentId,origin]=id.split('#')
    if(origin===undefined)return this.getCalendarEventById(id)
    if(!Number.isFinite(Number(origin)))return null
    const snapshot=this.snapshot(),parent=snapshot.events.find(e=>e.id===parentId)
    if(!parent)return null
    const found=findCalendarOccurrence(snapshot.events,`${parentId}|${originalFromSeconds(Number(origin),parent.allDay)}`)
    return found?{...calendarEventToRecord(found.event),id,start_time:found.start/1000,end_time:found.end/1000}:null
  }
  getCalendarEventById(id:string):CalendarEvent|null {const e=this.snapshot().events.find(e=>e.id===id);return e?calendarEventToRecord(e):null}
  getCalendarEvents(start:number,end:number):CalendarEvent[]{return this.snapshot().events.filter(e=>!e.recurringEventId).map(e=>calendarEventToRecord(e)).filter(e=>e.start_time<end&&e.end_time>start)}
  getNonRecurringEventsInWindow(start:number,end:number):CalendarEvent[]{return this.getCalendarEvents(start,end).filter(e=>!e.recurrence_rule&&!(e as unknown as {rdates?:unknown[]}).rdates?.length)}
  getRecurringEventsAndOverrides(_start:number,_end:number):{events:CalendarEvent[];overridesByParent:Map<string,EventOverride[]>}{
    const snapshot=this.snapshot(), parents=snapshot.events.filter(e=>isRecurring(e)&&!e.recurringEventId)
    const overridesByParent=new Map<string,EventOverride[]>()
    for(const parent of parents){const list:EventOverride[]=[]
      for(const d of parent.exdates||[])list.push({parentEventId:parent.id,occurrenceStart:originalToSeconds(d),kind:'cancelled',patch:null})
      for(const e of snapshot.events.filter(e=>e.recurringEventId===parent.id))list.push({parentEventId:parent.id,occurrenceStart:originalToSeconds(e.originalStart!),kind:'single',patch:calendarEventToRecord(e)})
      overridesByParent.set(parent.id,list)
    }
    return {events:parents.map(e=>calendarEventToRecord(e)),overridesByParent}
  }
  listOccurrences(start:number,end:number,zone=systemTimeZone()) {
    const snapshot=this.snapshot()
    return occurrences(snapshot.events,dayOf(start*1000,zone)-1,dayOf(end*1000,zone)+2,zone).filter(o=>o.end>start*1000&&o.start<end*1000)
  }
  getCalendarEventsWithReminders(start:number,end:number):EventInstance[]{
    const snapshot=this.snapshot();if(snapshot.prefs?.notifications===false)return [];const offsets=snapshot.events.flatMap(e=>(e.reminders||[]).filter(r=>r.method!=='email').map(r=>r.minutes*60))
    const zone=systemTimeZone(), lo=start+Math.min(0,...offsets),hi=end+Math.max(0,...offsets)
    return occurrences(snapshot.events,dayOf(lo*1000,zone)-1,dayOf(hi*1000,zone)+2,zone).filter(o=>o.event.reminders?.some(r=>r.method!=='email')).map(o=>({...calendarEventToRecord(o.event),id:o.seriesId?`${o.seriesId}#${originalToSeconds(o.event.originalStart??(o.allDay?isoDate(o.startDay):o.start))}`:o.event.id,instanceOf:o.seriesId||o.event.id,occurrenceStart:originalToSeconds(o.event.originalStart??(o.allDay?isoDate(o.startDay):o.start)),overrideKind:o.event.recurringEventId?'single':null,start_time:o.allDay?startOfDayMs(o.startDay,o.event.timeZone||zone)/1000:o.start/1000,end_time:o.allDay?startOfDayMs(o.endDay+1,o.event.timeZone||zone)/1000:o.end/1000})) as EventInstance[]
  }
  claimReminder(eventId:string,start:number,offset:number,method:string,now:number):boolean{
    const result=this.db.prepare('INSERT OR IGNORE INTO calendar_reminder_deliveries(event_id,occurrence_start,offset_minutes,method,delivered_at) VALUES (?,?,?,?,?)').run(eventId,start,offset,method,now) as {changes:number}
    return result.changes===1
  }

  importStandaloneSnapshot(input:CalendarSnapshot):{created:number;skipped:number}{
    return this.transaction(()=>{
      const before=this.snapshot(),existing=new Set(before.events.map(e=>e.id))
      const key=(kind:string,id:string)=>`standalone-${kind}-${createHash('sha256').update(id).digest('hex').slice(0,20)}`
      const ids=new Map(input.events.map(e=>[e.id,key('event',e.id)]))
      const put=input.events.filter(e=>!existing.has(ids.get(e.id)!)&&(!e.recurringEventId||!existing.has(ids.get(e.recurringEventId)!))).map(e=>({...e,id:ids.get(e.id)!,calendarId:key('calendar',e.calendarId),recurringEventId:e.recurringEventId?ids.get(e.recurringEventId):undefined,revision:0}))
      const needed=new Set(put.map(e=>e.calendarId))
      for(const source of input.calendars){const id=key('calendar',source.id);if(needed.has(id)&&!this.getCalendarSourceById(id))this.putCalendar({...source,id,primary:false,readOnly:false,accountId:'local',order:before.calendars.length+(source.order||0)})}
      if(put.length)this.commit({put,remove:[]},versionsOf(before.events))
      return {created:put.length,skipped:input.events.length-put.length}
    })
  }

  importCalendar(raw:string,sourceId?:string,name='导入的日历'):{sourceId:string;created:number;updated:number;skipped:number}{
    const id=sourceId||`ics-content-${createHash('sha256').update(raw.replace(/\r\n/g,'\n').trim()).digest('hex').slice(0,24)}`,parsed=importIcs(raw,id,systemTimeZone())
    if(parsed.warnings.length)throw new Error(`导入内容不完整，原数据未修改：${parsed.warnings.join('；')}`)
    if(!parsed.events.length)throw new Error('文件中没有可导入的日程')
    return this.transaction(()=>{
      if(this.getCalendarSourceById(id)?.sync_url)throw new Error('订阅日历为只读，请导入本地日历')
      if(!this.getCalendarSourceById(id))this.upsertCalendarSource({id,name:parsed.calendarName||name,color:parsed.calendarColor?.slice(0,7),type:'ics'})
      const result=this.replaceImportedCalendar(id,parsed.events,false)
      return {sourceId:id,created:result.created,updated:result.updated,skipped:0}
    })
  }
  replaceImportedCalendar(sourceId:string,events:CalEvent[],replace=true):{created:number;updated:number;removed:number}{
    if(!this.getCalendarSourceById(sourceId))throw new Error('日历不存在')
    const snapshot=this.snapshot(),mapping=new Map(events.filter(e=>!e.recurringEventId).map(e=>[e.id,importedId(sourceId,e.uid)]))
    const normalized=events.map(e=>({...e,calendarId:sourceId,id:e.recurringEventId?`${importedId(sourceId,e.uid)}-${originalToSeconds(e.originalStart!)}`:mapping.get(e.id)!,recurringEventId:e.recurringEventId?mapping.get(e.recurringEventId):undefined}))
    const incoming=new Set(normalized.map(e=>e.id)),existing=snapshot.events.filter(e=>e.calendarId===sourceId)
    const remove=replace?existing.filter(e=>!incoming.has(e.id)).map(e=>e.id):[]
    this.commit({put:normalized,remove},versionsOf(snapshot.events),sourceId)
    return {created:normalized.filter(e=>!existing.some(x=>x.id===e.id)).length,updated:normalized.filter(e=>existing.some(x=>x.id===e.id)).length,removed:remove.length}
  }
  recordSyncResult(id:string,error:string|null):void {this.db.prepare('UPDATE calendar_sources SET sync_error=?,last_synced_at=CASE WHEN ? IS NULL THEN unixepoch() ELSE last_synced_at END WHERE id=?').run(error,error,id);this.changed([id])}
  exportCalendar(id?:string):string {const snapshot=this.snapshot();return exportIcs(snapshot.events.filter(e=>!id||e.calendarId===id),{calendarName:snapshot.calendars.find(c=>c.id===id)?.name||'Ready'})}
}
