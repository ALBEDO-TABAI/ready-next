import { prepareStandaloneImport, applyStandaloneImport } from './standalone-import'
import { calendarErrorMessage } from './calendar-error'
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import { readCalendarFile, saveCalendarFile } from './calendar-files'
import { peekCalendarNavigation, acknowledgeCalendarNavigation, onCalendarNavigation, requestCalendarNavigation } from './calendar-navigation'
import { getDatabase } from '../database'
import { onCalendarChanged } from './calendar-change'
import type { CalendarCommand, CalendarDelta } from '../../../shared/calendar/commands'
import type { Calendar } from '../../../shared/calendar/model'

export function setupCalendarWorkbenchIPC(): void {
  const store = () => getDatabase().calendar
  const handle = (name:string, fn:(...args:any[])=>unknown) => ipcMain.handle(`calendar:${name}`,async (_event,...args)=>{
    try {return {success:true,mock:false,data:await fn(...args)}}
    catch(error){return {success:false,mock:false,error:calendarErrorMessage(error)}}
  })
  handle('revealEvent',(id:string)=>{if(!store().getCalendarEventReference(id))throw new Error('日程已不存在');requestCalendarNavigation({kind:'event',eventId:id});return true})
  handle('prepareStandaloneImport',prepareStandaloneImport)
  handle('applyStandaloneImport',applyStandaloneImport)
  handle('snapshot',()=>store().snapshot())
  handle('mutate',(command:CalendarCommand,versions:Record<string,number>)=>store().mutate(command,versions))
  handle('restore',(delta:CalendarDelta,versions:Record<string,number>)=>store().restore(delta,versions))
  handle('putCalendars',(calendars:Calendar[])=>{store().putCalendars(calendars);return store().snapshot()})
  handle('putCalendar',(calendar:Calendar)=>{store().putCalendar(calendar);return store().snapshot()})
  handle('deleteCalendar',(id:string)=>{store().deleteCalendarSource(id);return store().snapshot()})
  handle('putPreferences',(prefs:Record<string,unknown>)=>{store().savePreferences(prefs);return store().snapshot()})
  handle('exportIcs',(id?:string)=>store().exportCalendar(id))
  handle('importCalendar',(raw:string,name:string,sourceId?:string)=>store().importCalendar(raw,sourceId,name))
  handle('openIcs',()=>readCalendarFile())
  handle('saveIcs',saveCalendarFile)
  handle('peekNavigation',peekCalendarNavigation)
  handle('ackNavigation',acknowledgeCalendarNavigation)
  handle('openLink',async(url:string)=>{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))throw new Error('不支持的链接');await shell.openExternal(parsed.href);return true})
  handle('getLoginItem',()=>app.getLoginItemSettings().openAtLogin)
  handle('setLoginItem',(openAtLogin:boolean)=>{if(typeof openAtLogin!=='boolean')throw new Error('启动项参数无效');app.setLoginItemSettings({openAtLogin});return app.getLoginItemSettings().openAtLogin})
  onCalendarNavigation(()=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('calendar:navigationPending')})
  onCalendarChanged(ids=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('calendar:changed',{ids})})
}
