import { app, BrowserWindow, Menu, MenuItem, Tray, nativeImage, globalShortcut, shell, dialog } from 'electron'
import { consumeCalendarOpens } from '../../calendar-open-intents'
import { parseCalendarDeepLink, type CalendarNavigation } from '../../../shared/calendar/desktop'
import { getDatabase } from '../database'
import { requestCalendarNavigation } from './calendar-navigation'
import { readCalendarFile, saveCalendarFile } from './calendar-files'
import { onCalendarChanged } from './calendar-change'

const icon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQ0lEQVR4nGNgGGjACKX/k6ufiVIXDAMDYABfIOKS+08VFxBrwH9cLmEhQjMjPsnBEwsMDKQlZ7hadP8RawjecCEJAAAPuAkR3IaDSAAAAABJRU5ErkJggg=='

export function startCalendarDesktop(getWindow:()=>Promise<BrowserWindow|null>):()=>void {
  const image=nativeImage.createFromDataURL(icon);image.setTemplateImage(true)
  const tray=new Tray(image)
  let stopped=false,openQueue=Promise.resolve()
  const store=()=>getDatabase().calendar
  const show=async(target?:CalendarNavigation)=>{
    const window=await getWindow();if(!window||window.isDestroyed()||stopped)return
    if(target)requestCalendarNavigation(target)
    if(window.isMinimized())window.restore();window.show();window.focus()
    window.webContents.send('agent:toolAction',{tool:'app.switchMode',args:{mode:'calendar'},sessionId:null})
  }
  const report=(error:unknown)=>{console.error('[calendar desktop]',error);if(!stopped)void dialog.showMessageBox({type:'error',message:'日历操作未完成',detail:error instanceof Error?error.message:String(error)})}
  const perform=(work:()=>Promise<unknown>)=>{void work().catch(report)}
  const importFile=async(path?:string)=>{const file=await readCalendarFile(path);if(!file||stopped)return;store().importCalendar(file.text,file.sourceId,file.name);await show()}
  const join=async()=>{
    const now=Date.now()/1000,event=store().listOccurrences(now,now+7*86400).find(o=>!o.allDay&&o.event.conferenceUrl)
    if(event?.event.conferenceUrl)await shell.openExternal(event.event.conferenceUrl);else await show()
  }
  const menu=Menu.getApplicationMenu()
  const calendarMenu=new MenuItem({id:'ready-calendar-menu',label:'日历',submenu:[
    {label:'打开日历',click:()=>perform(()=>show())},
    {label:'新建日程',click:()=>perform(()=>show({kind:'command',command:'create'}))},
    {label:'搜索日程',click:()=>perform(()=>show({kind:'command',command:'search'}))},
    {type:'separator'},
    ...(['day','week','month'] as const).map((command,i)=>({label:['日视图','周视图','月视图'][i],click:()=>perform(()=>show({kind:'command',command}))})),
    {type:'separator'},
    {label:'导入日历文件…',click:()=>perform(()=>importFile())},
    {label:'导出全部日历…',click:()=>perform(()=>saveCalendarFile('Ready.ics',store().exportCalendar()))},
    {label:'加入下一场会议',click:()=>perform(join)},
    {label:'日历设置…',click:()=>perform(()=>show({kind:'command',command:'settings'}))},
  ]})
  if(menu){menu.append(calendarMenu);Menu.setApplicationMenu(menu)}
  const refresh=()=>{
    if(stopped)return
    const snapshot=store().snapshot(),now=Date.now()/1000
    const events=store().listOccurrences(now,now+2*86400).filter(o=>!o.allDay).slice(0,6)
    const next=events[0],label=next?`${new Date(next.start).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})} ${next.event.title||'未命名日程'}`:''
    const max=Math.max(8,Number(snapshot.prefs?.menuBarMaxLen||32))
    tray.setTitle(snapshot.prefs?.menuBarNext===false?'':label.length>max?label.slice(0,max-1)+'…':label)
    tray.setToolTip(label||'Ready 日历')
    tray.setContextMenu(Menu.buildFromTemplate([
      {label:'打开 Ready 日历',click:()=>perform(()=>show())},
      {label:'新建日程',click:()=>perform(()=>show({kind:'command',command:'create'}))},
      {type:'separator'},
      ...events.map(o=>({label:o.event.title||'未命名日程',click:()=>perform(()=>show({kind:'event',eventId:o.seriesId?`${o.seriesId}#${Number(o.event.originalStart??o.start)/1000}`:o.event.id}))})),
      {type:'separator'},{label:'加入下一场会议',enabled:events.some(o=>!!o.event.conferenceUrl),click:()=>perform(join)},
    ]))
  }
  const off=onCalendarChanged(()=>{try{refresh()}catch(error){console.error('[calendar tray]',error)}})
  const timer=setInterval(()=>{try{refresh()}catch(error){console.error('[calendar tray]',error)}},30000);refresh()
  const shortcutBase=process.platform==='darwin'?'Control+Command':'Control+Alt'
  const shortcuts=[[`${shortcutBase}+K`,()=>tray.popUpContextMenu()],[`${shortcutBase}+J`,()=>perform(join)]] as const
  const registered=shortcuts.filter(([key,fn])=>globalShortcut.register(key,fn)).map(([key])=>key)
  const unlisten=consumeCalendarOpens(intent=>{
    openQueue=openQueue.then(async()=>{
      if(stopped)return
      if(intent.kind==='file')await importFile(intent.value)
      else {const target=parseCalendarDeepLink(intent.value);if(target)await show(target)}
    }).catch(report)
  })
  if(app.isPackaged)app.setAsDefaultProtocolClient('ready')
  return()=>{if(stopped)return;stopped=true;off();unlisten();clearInterval(timer);registered.forEach(key=>globalShortcut.unregister(key));tray.destroy()}
}
