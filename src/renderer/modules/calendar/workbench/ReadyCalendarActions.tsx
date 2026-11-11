import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dayOf, isoDate, parseIsoDate, startOfDayMs } from '@shared/calendar'
import type { RemoteCalendarEventSuggestion } from '@shared/calendar-remote-channel'
import type { ReminderFirePayload } from '@shared/calendar-types'
import { useStore, getState, setState, periodDays, monthRange, findOccurrence, reload, createEvent, primaryCalendar, goToDay, select, toast, openOverlay, setView, openCalendarSettings } from './store'
import { api, unwrap } from './platform'
import { registerModuleAgentHandler } from '../../../utils/moduleAgentBridge'
import { useCalendarSession } from '../../../stores/useCalendarSession'

// The calendar's own actions. Their buttons sit in the foot of the calendar navigator (the shell sidebar, W2-T4);
// the dialogs stay with the calendar. The assistant has its own panel, so the navigator carries no assistant entry.
export function ReadyCalendarActions({active,buttonsHost}:{active:boolean;buttonsHost?:HTMLElement|null}) {
  const s=useStore(x=>({anchor:x.anchor,prefs:x.prefs,events:x.events,calendars:x.calendars,editing:x.editing,today:x.today,busy:x.busy}))
  const [panel,setPanel]=useState<'subscribe'|'quick'|null>(null)
  const [importPreview,setImportPreview]=useState<{ticket:string;fileName:string;calendars:number;events:number;possibleExamples:number}|null>(null),[skipExamples,setSkipExamples]=useState(false),[importing,setImporting]=useState(false)
  const [text,setText]=useState(''),[name,setName]=useState(''),[url,setUrl]=useState(''),[interval,setInterval]=useState(60)
  const [suggestion,setSuggestion]=useState<RemoteCalendarEventSuggestion|null>(null),[reminder,setReminder]=useState<ReminderFirePayload|null>(null)
  const consuming=useRef(false)
  useEffect(()=>{
    if(!active||s.busy)return
    const consume=async()=>{
      if(consuming.current)return;consuming.current=true
      try{
        const request=await unwrap(api().peekNavigation());if(!request)return
        await reload()
        const target=request.target
        if(target.kind==='day')goToDay(parseIsoDate(target.date))
        else if(target.kind==='event'){
          const [id,origin]=target.eventId.split('#'),event=getState().events[id]
          const key=origin?`${id}|${event?.allDay?new Date(Number(origin)*1000).toISOString().slice(0,10):Number(origin)*1000}`:id
          const found=findOccurrence(key);if(found){goToDay(found.startDay);select([key])}else toast('日程已不存在')
        }else if(target.command==='create'){
          const id=`native-${request.id}`,now=Math.ceil(Date.now()/900000)*900000
          if(getState().events[id])select([id]);else if(!await createEvent({id,uid:`${id}@ready.local`,start:now,end:now+getState().prefs.defaultEventDuration*60000,allDay:false},{draft:true}))return
        }else if(target.command==='settings')openCalendarSettings()
        else if(target.command==='search')openOverlay('search')
        else setView(target.command==='month'?'month':'default',target.command==='day'?1:7)
        await unwrap(api().ackNavigation(request.id))
      }catch(error){ console.warn('[ReadyCalendarActions] consume navigation request failed:', error instanceof Error ? error.message : String(error));toast(String(error))}finally{consuming.current=false}
    }
    const off=api().onNavigation(()=>{void consume()});void consume();return off
  },[active,s.busy])
  const selected=s.editing?findOccurrence(s.editing):undefined
  useEffect(()=>{
    if(!active)return
    const days=s.prefs.gridView==='month'?(()=>{const r=monthRange();return [r.first,r.first+r.weeks*7-1]})():periodDays()
    if(days.length)useCalendarSession.getState().setVisibleRange(new Date(startOfDayMs(days[0],s.prefs.primaryTimeZone)).toISOString(),new Date(startOfDayMs(days.at(-1)!+1,s.prefs.primaryTimeZone)).toISOString())
    const original=selected?.event.originalStart??(selected?.allDay?isoDate(selected.startDay):selected?.start)
    const instance=selected?.seriesId&&original!==undefined?`${selected.seriesId}#${typeof original==='string'?Date.parse(original)/1000:original/1000}`:selected?.event.id
    useCalendarSession.getState().setSelectedEvent({id:instance||null,title:selected?.event.title||null})
    useCalendarSession.getState().setDisplayTimezone(s.prefs.primaryTimeZone)
  },[active,s.anchor,s.prefs,s.editing,s.events])
  useEffect(()=>{
    if(!active)return
    return registerModuleAgentHandler('calendar',async({action})=>{
      if(action==='calendar.reloadWindow'){await reload();return {intent:'reload_calendar_window',summary:'日程已刷新'}}
      throw new Error(`Unsupported calendar renderer action: ${action}`)
    })
  },[active])
  useEffect(()=>{
    const off1=api().onRemoteEventSuggested(setSuggestion),off2=api().onReminderFired(setReminder)
    return()=>{off1();off2()}
  },[])
  const prepareImport=async()=>{try{setImportPreview(await unwrap(api().prepareStandaloneImport()));setSkipExamples(false)}catch(error){ console.warn('[ReadyCalendarActions] prepare standalone import failed:', error instanceof Error ? error.message : String(error));toast(String(error))}}
  const importStandalone=async()=>{if(!importPreview||importing)return;setImporting(true);try{const result=await unwrap(api().applyStandaloneImport(importPreview.ticket,skipExamples));await reload();setImportPreview(null);toast(`已迁入 ${result.created} 条日程，跳过 ${result.skipped} 条已存在记录`)}catch(error){ console.warn('[ReadyCalendarActions] apply standalone import failed:', error instanceof Error ? error.message : String(error));toast(String(error))}finally{setImporting(false)}}
  const open=(next:typeof panel)=>{setPanel(next);setText('')}
  const jump=(payload:ReminderFirePayload)=>{
    const [id,origin]=payload.eventId.split('#'),event=getState().events[id]
    const key=origin?`${id}|${event?.allDay?new Date(Number(origin)*1000).toISOString().slice(0,10):Number(origin)*1000}`:id
    const o=findOccurrence(key);goToDay(o?.startDay??dayOf(payload.eventStartTime*1000,s.prefs.primaryTimeZone));if(o)select([key]);setReminder(null)
  }
  const accept=async()=>{
    if(!suggestion)return
    const allDay=!suggestion.hasTime,day=dayOf(suggestion.suggestedStartUnix*1000,s.prefs.primaryTimeZone)
    const id=await createEvent({title:suggestion.suggestedTitle,description:suggestion.source.text,allDay,start:allDay?isoDate(day):suggestion.suggestedStartUnix*1000,end:allDay?isoDate(day+1):suggestion.suggestedEndUnix*1000,calendarId:primaryCalendar()?.id})
    if(id){goToDay(day);setSuggestion(null)}
  }
  const subscribe=async()=>{try{const response=await unwrap(api().subscribeUrl({url,name,syncIntervalMinutes:interval}));await reload();toast(`已订阅，读取 ${response.initialEvents} 条日程`);setPanel(null)}catch(error){ console.warn('[ReadyCalendarActions] subscribe calendar failed:', error instanceof Error ? error.message : String(error));toast(String(error))}}
  const quick=async()=>{try{
    const found=await unwrap(api().detectTimeExpressions({text}));if(!found.length){toast('没有识别到明确时间，请补充日期和时间');return}
    if(found.length>1){toast('识别到多个时间，请每次输入一条日程');return}
    const e=found[0],day=dayOf(e.startTime*1000,s.prefs.primaryTimeZone)
    const id=await createEvent({title:text,allDay:!e.hasTime,start:e.hasTime?e.startTime*1000:isoDate(day),end:e.hasTime?e.endTime*1000:isoDate(day+1)})
    if(id){goToDay(day);setPanel(null)}
  }catch(error){ console.warn('[ReadyCalendarActions] create event from text failed:', error instanceof Error ? error.message : String(error));toast(String(error))}}
  return <>
    {buttonsHost&&createPortal(<div className="ready-calendar-actions"><button className="btn sm" onClick={()=>open('quick')}>快建</button><button className="btn sm" onClick={()=>open('subscribe')}>订阅</button><button className="btn sm" title="从独立日历迁入数据" onClick={()=>void prepareImport()}>迁入</button></div>,buttonsHost)}
    {importPreview&&<><div className="scrim dim"/><section className="ready-calendar-dialog" role="dialog" aria-label="迁入独立日历"><header><strong>迁入独立日历</strong></header><p>{importPreview.fileName}：{importPreview.calendars} 个分类，{importPreview.events} 条日程。</p><p>将保存为 Ready 本地日程；已经迁入的日程不会重复或被覆盖。</p>{importPreview.possibleExamples>0&&<label style={{display:'block',margin:'12px 0'}}><input type="checkbox" checked={skipExamples} onChange={e=>setSkipExamples(e.target.checked)}/> 跳过与内置示例同名且未修改的 {importPreview.possibleExamples} 条日程</label>}<button className="btn primary" disabled={importing} onClick={()=>void importStandalone()}>确认迁入</button> <button className="btn" disabled={importing} onClick={()=>setImportPreview(null)}>取消</button></section></>}
    {panel&&<><div className="scrim dim" onPointerDown={()=>setPanel(null)}/><section className="ready-calendar-dialog" role="dialog" aria-label={panel==='subscribe'?'订阅日历':'快速创建日程'} onKeyDown={e=>e.stopPropagation()}>
      <header><strong>{panel==='subscribe'?'订阅日历':'快速创建日程'}</strong><button className="btn sm" onClick={()=>setPanel(null)}>关闭</button></header>
      {panel==='subscribe'?<form onSubmit={e=>{e.preventDefault();void subscribe()}}><label>日历名称<input autoFocus required value={name} onChange={e=>setName(e.target.value)}/></label><label>订阅网址<input type="url" required value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://…/calendar.ics"/></label><label>更新间隔<select value={interval} onChange={e=>setInterval(Number(e.target.value))}><option value={15}>15 分钟</option><option value={60}>1 小时</option><option value={360}>6 小时</option></select></label><button className="btn primary" type="submit">订阅</button></form>:<form onSubmit={e=>{e.preventDefault();void quick()}}><label>用一句话填写日程（按本地时间识别）<input autoFocus required value={text} onChange={e=>setText(e.target.value)} placeholder="明天下午三点开会"/></label><button className="btn primary" type="submit" disabled={s.busy}>创建并编辑</button></form>}
    </section></>}
    {suggestion&&<div className="ready-calendar-notice"><strong>消息中的日程建议</strong><p>{suggestion.suggestedTitle}</p><button className="btn sm" onClick={()=>void accept()} disabled={s.busy}>加入日历</button><button className="btn sm" onClick={()=>setSuggestion(null)}>忽略</button></div>}
    {reminder&&<div className="ready-calendar-notice reminder"><strong>{reminder.eventTitle}</strong><p>日程提醒</p><button className="btn sm" onClick={()=>jump(reminder)}>查看日程</button><button className="btn sm" onClick={()=>setReminder(null)}>关闭</button></div>}
  </>
}
