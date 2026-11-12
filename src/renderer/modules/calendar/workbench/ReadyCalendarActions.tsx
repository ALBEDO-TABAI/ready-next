import { useEffect, useRef, useState } from 'react'
import { dayOf, isoDate, parseIsoDate, startOfDayMs } from '@shared/calendar'
import type { RemoteCalendarEventSuggestion } from '@shared/calendar-remote-channel'
import type { ReminderFirePayload } from '@shared/calendar-types'
import { useStore, getState, setState, periodDays, monthRange, findOccurrence, reload, createEvent, primaryCalendar, goToDay, select, toast, openOverlay, setView, openCalendarSettings } from './store'
import { joinNext } from './commands'
import { newEventNow } from './components/Sidebar'
import { api, unwrap } from './platform'
import { registerModuleAgentHandler } from '../../../utils/moduleAgentBridge'
import { useCalendarSession } from '../../../stores/useCalendarSession'
import { Button } from '../../../components/ui/Button'
import { Input, Select } from '../../../components/ui/Field'
import { openCalendarFloat } from './floats'

// The calendar's own dialogs (quick create, subscribe) and the requests that reach it from elsewhere. Their entries
// are the sidebar's new button and its 新建日历 menu (W4 §4); the one-time 迁入 lives in 设置 › 日历.
export function ReadyCalendarActions({active}:{active:boolean}) {
  const s=useStore(x=>({anchor:x.anchor,prefs:x.prefs,events:x.events,calendars:x.calendars,editing:x.editing,today:x.today,busy:x.busy,actionPanel:x.actionPanel}))
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
          const found=findOccurrence(key);if(found){goToDay(found.startDay);select([key],{record:false})}else toast('日程已不存在')
        }else if(target.command==='create'){
          const id=`native-${request.id}`,now=Math.ceil(Date.now()/900000)*900000
          if(getState().events[id])select([id]);else if(!await createEvent({id,uid:`${id}@ready.local`,start:now,end:now+getState().prefs.defaultEventDuration*60000,allDay:false},{draft:true}))return
        }else if(target.command==='settings')openCalendarSettings()
        else if(target.command==='join'){if(!joinNext())toast('今天没有带会议链接的日程')}
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
  useEffect(()=>{if(!s.actionPanel)return;openActionDialog(s.actionPanel);setState({actionPanel:null})},[s.actionPanel])
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
  // Remote suggestions and fired reminders wait in the corner until answered (the float material, not a toast: they
  // stay until the person decides).
  if(!suggestion&&!reminder)return null
  return <div className="ready-calendar-notices">
    {suggestion&&<div className="ready-calendar-notice rn-float" role="status"><strong>消息中的日程建议</strong><p>{suggestion.suggestedTitle}</p><div className="ready-calendar-notice-actions"><Button size="sm" variant="primary" onClick={()=>void accept()} disabled={s.busy}>加入日历</Button><Button size="sm" variant="ghost" onClick={()=>setSuggestion(null)}>忽略</Button></div></div>}
    {reminder&&<div className="ready-calendar-notice rn-float" role="status"><strong>{reminder.eventTitle}</strong><p>日程提醒</p><div className="ready-calendar-notice-actions"><Button size="sm" onClick={()=>jump(reminder)}>查看日程</Button><Button size="sm" variant="ghost" onClick={()=>setReminder(null)}>关闭</Button></div></div>}
  </div>
}

const CENTER={left:0,top:0,right:0,bottom:0}
/** 快速创建 and 订阅日历: dialogs in the app's float layer (W1 §5). */
function openActionDialog(kind:'quick'|'subscribe'){
  openCalendarFloat({anchor:CENTER,placement:'center',modal:true,role:'dialog',label:kind==='subscribe'?'订阅日历':'快速创建日程',className:'rn-dialog cal-form',
    render:close=>kind==='subscribe'?<SubscribeForm close={close}/>:<QuickCreateForm close={close}/>})
}

function QuickCreateForm({close}:{close:()=>void}){
  const busy=useStore(x=>x.busy)
  const [text,setText]=useState('')
  const quick=async()=>{try{
    const found=await unwrap(api().detectTimeExpressions({text}));if(!found.length){toast('没有识别到明确时间，请补充日期和时间');return}
    if(found.length>1){toast('识别到多个时间，请每次输入一条日程');return}
    const e=found[0],day=dayOf(e.startTime*1000,getState().prefs.primaryTimeZone)
    const id=await createEvent({title:text,allDay:!e.hasTime,start:e.hasTime?e.startTime*1000:isoDate(day),end:e.hasTime?e.endTime*1000:isoDate(day+1)})
    if(id){goToDay(day);close()}
  }catch(error){ console.warn('[ReadyCalendarActions] create event from text failed:', error instanceof Error ? error.message : String(error));toast(String(error))}}
  return <form onSubmit={e=>{e.preventDefault();void quick()}} onKeyDown={e=>e.stopPropagation()}>
    <h2 className="rn-dialog__title">快速创建日程</h2>
    <label className="cal-form-field"><span>用一句话填写日程（按本地时间识别）</span><Input data-autofocus required value={text} onChange={e=>setText(e.target.value)} placeholder="明天下午三点开会"/></label>
    <div className="rn-dialog__actions"><Button variant="ghost" disabled={busy} onClick={()=>{close();newEventNow()}}>空白日程</Button><Button type="submit" variant="primary" disabled={busy}>创建并编辑</Button></div>
  </form>
}

function SubscribeForm({close}:{close:()=>void}){
  const [name,setName]=useState(''),[url,setUrl]=useState(''),[interval,setInterval]=useState('60')
  const subscribe=async()=>{try{const response=await unwrap(api().subscribeUrl({url,name,syncIntervalMinutes:Number(interval)}));await reload();toast(`已订阅，读取 ${response.initialEvents} 条日程`);close()}catch(error){ console.warn('[ReadyCalendarActions] subscribe calendar failed:', error instanceof Error ? error.message : String(error));toast(String(error))}}
  return <form onSubmit={e=>{e.preventDefault();void subscribe()}} onKeyDown={e=>e.stopPropagation()}>
    <h2 className="rn-dialog__title">订阅日历</h2>
    <label className="cal-form-field"><span>日历名称</span><Input data-autofocus required value={name} onChange={e=>setName(e.target.value)}/></label>
    <label className="cal-form-field"><span>订阅网址</span><Input type="url" required value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://…/calendar.ics"/></label>
    <label className="cal-form-field"><span>更新间隔</span><Select value={interval} onChange={e=>setInterval(e.target.value)} options={[{value:'15',label:'15 分钟'},{value:'60',label:'1 小时'},{value:'360',label:'6 小时'}]}/></label>
    <div className="rn-dialog__actions"><Button variant="ghost" onClick={close}>取消</Button><Button type="submit" variant="primary">订阅</Button></div>
  </form>
}
