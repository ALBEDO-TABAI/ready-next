import { withSystemTimeFormat } from './time-format'
import { createCalendarMeetingNotesRuntime } from './meeting-notes-runtime'
import { prepareStandaloneImport, applyStandaloneImport } from './standalone-import'
import { readCalendarAttachmentDisplayRefs } from './ready-ref-migration'
import { calendarErrorMessage } from './calendar-error'
import { BrowserWindow, app, ipcMain, systemPreferences } from 'electron'
import { readCalendarFile, saveCalendarFile } from './calendar-files'
import { peekCalendarNavigation, acknowledgeCalendarNavigation, onCalendarNavigation, requestCalendarNavigation } from './calendar-navigation'
import { getDatabase } from '../database'
import { onCalendarChanged } from './calendar-change'
import type { CalendarCommand, CalendarDelta, CalendarSnapshot } from '../../../shared/calendar/commands'
import type { Calendar } from '../../../shared/calendar/model'

export function setupCalendarWorkbenchIPC(): void {
  const store = () => getDatabase().calendar
  const displaySnapshot = (value: CalendarSnapshot) => withSystemTimeFormat(value, () => process.platform === 'darwin'
    ? systemPreferences.getUserDefault('AppleICUForce24HourTime', 'boolean')
    : ['h23', 'h24'].includes(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle!))
  const snapshot = () => displaySnapshot(store().snapshot())
  const createMeetingNote = createCalendarMeetingNotesRuntime()
  const receipt = <Args extends unknown[], T>(fn:(...args:Args)=>T) => async (_event:unknown,...args:Args)=>{
    try {return {success:true,mock:false,data:await fn(...args)}}
    catch(error){return {success:false,mock:false,error:calendarErrorMessage(error)}}
  }
  ipcMain.handle('calendar:revealEvent',receipt((id:string)=>{if(!store().getCalendarEventReference(id))throw new Error('日程已不存在');requestCalendarNavigation({kind:'event',eventId:id});return true}))
  ipcMain.handle('calendar:revealDay',receipt((date:unknown)=>{if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(`${date}T00:00:00Z`)))throw new Error('日期无效');requestCalendarNavigation({kind:'day',date});return true}))
  ipcMain.handle('calendar:getAttachmentDisplayRefs',receipt((messageIds:unknown)=>{
    if(!Array.isArray(messageIds)||messageIds.some(id=>typeof id!=='string'||!id.trim()||id!==id.trim()))throw new Error('消息 ID 列表无效')
    const db=getDatabase().getRawDb()
    if(!db)throw new Error('历史数据库不可用')
    return readCalendarAttachmentDisplayRefs(db,messageIds)
  }))
  ipcMain.handle('calendar:prepareStandaloneImport',receipt(prepareStandaloneImport))
  ipcMain.handle('calendar:applyStandaloneImport',receipt(applyStandaloneImport))
  ipcMain.handle('calendar:createMeetingNote',receipt(createMeetingNote.create))
  ipcMain.handle('calendar:pendingMeetingNote',receipt(createMeetingNote.pending))
  ipcMain.handle('calendar:snapshot',receipt(snapshot))
  ipcMain.handle('calendar:mutate',receipt((command:CalendarCommand,versions:Record<string,number>)=>{const result=store().mutate(command,versions);return {...result,snapshot:displaySnapshot(result.snapshot)}}))
  ipcMain.handle('calendar:restore',receipt((delta:CalendarDelta,versions:Record<string,number>)=>{const result=store().restore(delta,versions);return {...result,snapshot:displaySnapshot(result.snapshot)}}))
  ipcMain.handle('calendar:putCalendars',receipt((calendars:Calendar[])=>{store().putCalendars(calendars);return snapshot()}))
  ipcMain.handle('calendar:putCalendar',receipt((calendar:Calendar)=>{store().putCalendar(calendar);return snapshot()}))
  ipcMain.handle('calendar:deleteCalendar',receipt((id:string)=>{store().deleteCalendarSource(id);return snapshot()}))
  ipcMain.handle('calendar:putPreferences',receipt((prefs:Record<string,unknown>)=>{store().savePreferences(prefs);return snapshot()}))
  ipcMain.handle('calendar:exportIcs',receipt((id?:string)=>store().exportCalendar(id)))
  ipcMain.handle('calendar:importCalendar',receipt((raw:string,name:string,sourceId?:string)=>store().importCalendar(raw,sourceId,name)))
  ipcMain.handle('calendar:openIcs',receipt(()=>readCalendarFile()))
  ipcMain.handle('calendar:saveIcs',receipt(saveCalendarFile))
  ipcMain.handle('calendar:peekNavigation',receipt(peekCalendarNavigation))
  ipcMain.handle('calendar:ackNavigation',receipt(acknowledgeCalendarNavigation))
  ipcMain.handle('calendar:getLoginItem',receipt(()=>app.getLoginItemSettings().openAtLogin))
  ipcMain.handle('calendar:setLoginItem',receipt((openAtLogin:boolean)=>{if(typeof openAtLogin!=='boolean')throw new Error('启动项参数无效');app.setLoginItemSettings({openAtLogin});return app.getLoginItemSettings().openAtLogin}))
  onCalendarNavigation(()=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('calendar:navigationPending')})
  onCalendarChanged(ids=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('calendar:changed',{ids})})
}
