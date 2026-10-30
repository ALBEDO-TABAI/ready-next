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
  const receipt = <Args extends unknown[], T>(fn:(...args:Args)=>T) => async (_event:unknown,...args:Args)=>{
    try {return {success:true,mock:false,data:await fn(...args)}}
    catch(error){return {success:false,mock:false,error:calendarErrorMessage(error)}}
  }
  ipcMain.handle('calendar:revealEvent',receipt((id:string)=>{if(!store().getCalendarEventReference(id))throw new Error('日程已不存在');requestCalendarNavigation({kind:'event',eventId:id});return true}))
  ipcMain.handle('calendar:prepareStandaloneImport',receipt(prepareStandaloneImport))
  ipcMain.handle('calendar:applyStandaloneImport',receipt(applyStandaloneImport))
  ipcMain.handle('calendar:snapshot',receipt(()=>store().snapshot()))
  ipcMain.handle('calendar:mutate',receipt((command:CalendarCommand,versions:Record<string,number>)=>store().mutate(command,versions)))
  ipcMain.handle('calendar:restore',receipt((delta:CalendarDelta,versions:Record<string,number>)=>store().restore(delta,versions)))
  ipcMain.handle('calendar:putCalendars',receipt((calendars:Calendar[])=>{store().putCalendars(calendars);return store().snapshot()}))
  ipcMain.handle('calendar:putCalendar',receipt((calendar:Calendar)=>{store().putCalendar(calendar);return store().snapshot()}))
  ipcMain.handle('calendar:deleteCalendar',receipt((id:string)=>{store().deleteCalendarSource(id);return store().snapshot()}))
  ipcMain.handle('calendar:putPreferences',receipt((prefs:Record<string,unknown>)=>{store().savePreferences(prefs);return store().snapshot()}))
  ipcMain.handle('calendar:exportIcs',receipt((id?:string)=>store().exportCalendar(id)))
  ipcMain.handle('calendar:importCalendar',receipt((raw:string,name:string,sourceId?:string)=>store().importCalendar(raw,sourceId,name)))
  ipcMain.handle('calendar:openIcs',receipt(()=>readCalendarFile()))
  ipcMain.handle('calendar:saveIcs',receipt(saveCalendarFile))
  ipcMain.handle('calendar:peekNavigation',receipt(peekCalendarNavigation))
  ipcMain.handle('calendar:ackNavigation',receipt(acknowledgeCalendarNavigation))
  ipcMain.handle('calendar:openLink',receipt(async(url:string)=>{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))throw new Error('不支持的链接');await shell.openExternal(parsed.href);return true}))
  ipcMain.handle('calendar:getLoginItem',receipt(()=>app.getLoginItemSettings().openAtLogin))
  ipcMain.handle('calendar:setLoginItem',receipt((openAtLogin:boolean)=>{if(typeof openAtLogin!=='boolean')throw new Error('启动项参数无效');app.setLoginItemSettings({openAtLogin});return app.getLoginItemSettings().openAtLogin}))
  onCalendarNavigation(()=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('calendar:navigationPending')})
  onCalendarChanged(ids=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('calendar:changed',{ids})})
}
