import { calendarErrorMessage } from './calendar-error'
import { ipcMain } from 'electron'
import { getDatabase } from '../database'
import { serializeEventToWire, serializeSourceToWire } from '../../../shared/calendar-wire'
import { calendarEventToRecord, originalToSeconds } from './calendar-row-codec'
import { calendarSeconds } from './calendar-input'
import { detectTimeExpressions } from './time-expression-detector'
import { detectRemoteChannelEventSuggestions } from './remote-channel-event-detector'
import { listRemoteChannelEntries } from './remote-channel-registry'
import { setupCalendarWorkbenchIPC } from './workbench-ipc'
import type { SyncScheduler } from './sync-scheduler'
import type { RemoteChannelMessage } from '../../../shared/calendar-remote-channel'
import { newId } from '../../../shared/calendar/model'

export interface CalendarResponse<T>{success:boolean;mock:boolean;data?:T;error?:string}
export interface CalendarIPCOptions {syncScheduler?:SyncScheduler}
export function setupCalendarIPC(_useMock=false,options:CalendarIPCOptions={}):void{
  setupCalendarWorkbenchIPC()
  const store=()=>getDatabase().calendar
  const handle=(name:string,fn:(...args:any[])=>unknown)=>ipcMain.handle(`calendar:${name}`,async(_event,...args)=>{try{return{success:true,mock:false,data:await fn(...args)}}catch(error){return{success:false,mock:false,error:calendarErrorMessage(error)}}})
  handle('getSources',()=>store().getCalendarSources().map(source=>serializeSourceToWire({...source,enabled:!!(source as unknown as {visible:number}).visible})))
  handle('getEvents',({start,end,timeZone}:{start:unknown;end:unknown;timeZone?:string})=>{
    const a=calendarSeconds(start),b=calendarSeconds(end);if(a>=b)throw new Error('日历窗口无效')
    const parents=new Map(store().snapshot().events.map(e=>[e.id,e]))
    return store().listOccurrences(a,b,timeZone).map(o=>{
      const original=originalToSeconds(o.event.originalStart??(o.allDay?new Date(o.startDay*86400000).toISOString().slice(0,10):o.start))
      const parent=o.seriesId||o.event.id,id=o.seriesId?`${parent}#${original}`:parent
      return serializeEventToWire({...calendarEventToRecord(o.event),recurrence_rule:parents.get(parent)?.rrule||null,id,start_time:o.start/1000,end_time:o.end/1000,instanceOf:parent,occurrenceStart:original,syntheticId:id,overrideKind:o.event.recurringEventId?'single':null})
    })
  })
  handle('subscribeUrl',async(p:{url:string;name:string;color?:string;syncIntervalMinutes?:number})=>{
    const url=new URL(p.url);if(!['http:','https:'].includes(url.protocol)||!p.name.trim())throw new Error('请填写日历名称和有效的订阅网址')
    if(!options.syncScheduler)throw new Error('订阅服务尚未启动')
    const existing=store().getCalendarSources().find(s=>s.sync_url===url.href)
    const sourceId=existing?.id||newId('sub')
    if(!existing)store().upsertCalendarSource({id:sourceId,name:p.name.trim(),color:p.color,type:'subscription',syncUrl:url.href,syncInterval:Math.max(5,p.syncIntervalMinutes||60),enabled:true})
    const result=await options.syncScheduler.syncOne(sourceId)
    if(!result.ok){if(!existing)store().deleteCalendarSource(sourceId);throw new Error(result.error||'订阅失败，未改变原日历')}
    options.syncScheduler.startPeriodic();return{sourceId,initialEvents:result.eventsCreated+result.eventsUpdated}
  })
  handle('unsubscribeSource',(id:string)=>{const result=store().deleteCalendarSource(id);options.syncScheduler?.startPeriodic();return{removed:result.deleted}})
  handle('syncSourceNow',async(id:string)=>{if(!options.syncScheduler)throw new Error('订阅服务尚未启动');const result=await options.syncScheduler.syncOne(id);if(!result.ok)throw new Error(result.error||'同步失败');return result})
  handle('detectTimeExpressions',(p:{text?:unknown;referenceDate?:unknown})=>{
    if(typeof p?.text!=='string'||!p.text)return[]
    const date=p.referenceDate===undefined?new Date():new Date(p.referenceDate as string|number)
    return detectTimeExpressions(p.text.slice(0,8192),Number.isNaN(date.getTime())?new Date():date)
  })
  handle('detectRemoteChannelEvent',(p:{message:RemoteChannelMessage;autoDetectOverride?:boolean|null;minConfidence?:'high'|'medium'|'low'})=>{
    if(!p?.message||typeof p.message.text!=='string'||typeof p.message.channelKind!=='string')throw new Error('消息缺少必要内容')
    return detectRemoteChannelEventSuggestions(p.message,{autoDetectOverride:p.autoDetectOverride??null,minConfidence:p.minConfidence})
  })
  handle('listRemoteChannelEntries',()=>listRemoteChannelEntries().map(({kind,displayName,iconKey,autoDetectByDefault})=>({kind,displayName,iconKey,autoDetectByDefault})))
}
