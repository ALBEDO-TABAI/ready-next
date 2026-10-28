import { app, dialog } from 'electron'
import Database from 'better-sqlite3'
import { readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CalendarSnapshot } from '../../../shared/calendar/commands'
import type { Calendar } from '../../../shared/calendar/model'
import { validateCalendarEvent } from '../../../shared/calendar/validation'
import { getDatabase } from '../database'

const examples=new Set(['Team standup','Design review','Roadmap sync','1:1','Lunch with Sam','Gym','Piano lesson','Focus time','Dentist','Trip to the coast','Public holiday','Mum’s birthday'])
let prepared:{ticket:string;snapshot:CalendarSnapshot;exampleIds:string[]}|null=null

export async function prepareStandaloneImport(){
  const picked=await dialog.showOpenDialog({defaultPath:join(app.getPath('appData'),'Tempo','tempo.db'),properties:['openFile'],filters:[{name:'独立日历数据',extensions:['db','sqlite','json']}]})
  const path=picked.filePaths[0];if(picked.canceled||!path)return null
  let calendars:unknown[],events:unknown[]
  if(extname(path).toLowerCase()==='.json'){
    const raw=JSON.parse(await readFile(path,'utf8'))
    if(!raw.calendar||!raw.event)throw new Error('请选择独立日历保存的 tempo.json 文件')
    calendars=Object.values(raw.calendar);events=Object.values(raw.event)
  }else{
    const db=new Database(path,{readonly:true,fileMustExist:true})
    try{
      if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='item'").get())throw new Error('这不是独立日历的数据文件')
      const rows=db.prepare("SELECT kind,data FROM item WHERE kind IN ('calendar','event')").all() as {kind:string;data:string}[]
      calendars=rows.filter(r=>r.kind==='calendar').map(r=>JSON.parse(r.data));events=rows.filter(r=>r.kind==='event').map(r=>JSON.parse(r.data))
    }finally{db.close()}
  }
  const checked=events.map(validateCalendarEvent)
  const sources=calendars.map((raw)=>{
    const c=raw as Calendar
    if(!c.id||!c.name||!/^#[0-9a-f]{6}$/i.test(c.color))throw new Error('独立日历分类数据不完整')
    return {id:c.id,accountId:'local',name:c.name,color:c.color,visible:c.visible!==false,order:c.order||0} as Calendar
  })
  if(checked.some(e=>!sources.some(c=>c.id===e.calendarId)))throw new Error('有日程缺少对应分类，尚未导入')
  const exampleIds=checked.filter(e=>examples.has(e.title)&&e.createdAt===e.updatedAt).map(e=>e.id)
  const ticket=randomUUID();prepared={ticket,snapshot:{calendars:sources,events:checked},exampleIds}
  return {ticket,fileName:basename(path),calendars:sources.length,events:checked.length,possibleExamples:exampleIds.length}
}

export function applyStandaloneImport(ticket:string,skipExamples:boolean){
  if(!prepared||prepared.ticket!==ticket)throw new Error('导入预览已过期，请重新选择文件')
  const {snapshot,exampleIds}=prepared
  const skip=new Set(skipExamples?exampleIds:[])
  const selected={...snapshot,events:snapshot.events.filter(e=>!skip.has(e.id)&&!skip.has(e.recurringEventId||''))}
  const result=getDatabase().calendar.importStandaloneSnapshot(selected)
  prepared=null
  return result
}
