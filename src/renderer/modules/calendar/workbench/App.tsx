import { ThisDay } from '../linkage/ThisDay'
import { isoDate } from '../../../../shared/calendar/dates'
import { useEffect, useRef, useState } from 'react'
import { useStore, isDark, getState, setState, init, reload, toast } from './store'
import { handleKey } from './commands'
import { api, unwrap } from './platform'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { TimeGrid } from './components/TimeGrid'
import { MonthGrid } from './components/MonthGrid'
import { Panel } from './components/Panel'
import { Menus } from './components/Menus'
import { CommandMenu } from './components/CommandMenu'
import { Settings } from './components/Settings'
import { Toasts, ScopeDialog, GotoDialog, RecurrenceDialog } from './components/Overlays'
import { useTheme } from '../../../stores/useTheme'
import { dayOf } from '@shared/calendar'
import { ReadyCalendarActions } from './ReadyCalendarActions'
import './styles/tokens.css'
import './styles/app.css'

export function App({active=true}:{active?:boolean}) {
  const root=useRef<HTMLDivElement>(null)
  const [hasActivated,setHasActivated]=useState(false)
  const activity=useRef({active:false,dirty:false})
  const s=useStore(x=>({anchor:x.anchor,days:x.prefs.daysPerPeriod,zone:x.prefs.primaryTimeZone,ready:x.ready,dark:isDark(x),view:x.prefs.gridView,sidebar:x.prefs.sidebar,panel:x.prefs.contextPanel,overlay:x.overlay,error:x.error,busy:x.busy}))
  const theme=useTheme(x=>x.theme),dark=useTheme(x=>x.resolvedTheme==='dark')
  useEffect(()=>setState(x=>({systemDark:dark,prefs:{...x.prefs,interfaceTheme:theme}})),[theme,dark])
  useEffect(()=>{
    const element=root.current;if(!element)return
    let last=''
    const resize=()=>{
      const width=element.clientWidth,band=width<680?'small':width<1050?'compact':'wide'
      if(!width||band===last)return;last=band
      if(band!=='wide')setState(x=>({prefs:{...x.prefs,contextPanel:false,sidebar:band==='small'?false:x.prefs.sidebar}}))
    }
    const observer=new ResizeObserver(resize);observer.observe(element);resize()
    return()=>observer.disconnect()
  },[s.ready])
  useEffect(()=>{
    const current=activity.current
    current.active=active
    if(!active)return
    setHasActivated(true)
    if(current.dirty){current.dirty=false;void reload()}
    const timer=window.setInterval(()=>{const now=Date.now();setState({now,today:dayOf(now,getState().prefs.primaryTimeZone)})},15000)
    return()=>{current.active=false;clearInterval(timer)}
  },[active])
  useEffect(()=>{
    if(!hasActivated)return
    // Keep a passive invalidation listener so background changes refresh only on return.
    const off=api().onChanged(()=>{if(activity.current.active)void reload();else activity.current.dirty=true})
    void init()
    void unwrap(api().getLoginItem()).then(value=>setState(x=>({prefs:{...x.prefs,openAtLogin:value}}))).catch(error=>toast(String(error)))
    return off
  },[hasActivated])
  useEffect(()=>{if(active&&!s.overlay&&document.activeElement===document.body)root.current?.focus({preventScroll:true})},[active,s.overlay])
  const onKeyDown=(event:React.KeyboardEvent)=>{
    if(!active)return
    if(event.key==='Escape'&&(event.target as HTMLElement).dataset.testid==='ev-title')return
    if(handleKey(event.nativeEvent)){event.preventDefault();event.stopPropagation();if(document.activeElement===document.body)root.current?.focus({preventScroll:true})}
  }
  return <div ref={root} className={`ready-calendar${s.dark?' dark':''}`} data-testid="ready-calendar" tabIndex={-1} onPointerDownCapture={event=>{if(!(event.target as HTMLElement).closest('input,textarea,button,select,[contenteditable=true]'))root.current?.focus({preventScroll:true})}} onKeyDownCapture={onKeyDown}>
    {!s.ready ? <div className="calendar-load-state">{s.error||'正在读取日程…'}{s.error&&<button className="btn" onClick={()=>void init()}>重新读取</button>}</div> : <>
      <div className="app" data-view={s.view}>
        {s.sidebar&&<Sidebar/>}
        <main className="main" data-liquid-scroll-root="calendar-workbench-main"><TopBar/>{s.view==='month'?<MonthGrid active={active}/>:<TimeGrid active={active}/>}{active&&s.view!=='month'&&s.days===1&&<ThisDay date={isoDate(s.anchor)} timeZone={s.zone}/>}</main>
        {s.panel&&<Panel/>}
        <Menus/>{s.overlay==='cmdk'&&<CommandMenu/>}{s.overlay==='settings'&&<Settings/>}{s.overlay==='goto'&&<GotoDialog/>}{s.overlay==='recurrence'&&<RecurrenceDialog/>}<ScopeDialog/><Toasts/>
        {/* Its buttons sit at the foot of the sidebar; with the sidebar hidden they would cover the grid. */}
        <ReadyCalendarActions active={active} buttons={s.sidebar}/>
      </div>
      {s.error&&<div role="alert" className="calendar-save-status error">未保存：{s.error}</div>}
      {s.busy&&<div role="status" className="calendar-save-status">正在保存…</div>}
    </>}
  </div>
}
