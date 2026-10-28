import type { CalEvent } from '../../../shared/calendar/model'
import { newId } from '../../../shared/calendar/model'
import { dayOf, fromWall, systemTimeZone } from '../../../shared/calendar/tz'
import { isoDate, parseIsoDate } from '../../../shared/calendar/dates'

export function calendarSeconds(value:unknown,zone=systemTimeZone()):number {
  if(typeof value==='string'){
    const local=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
    if(local){parseIsoDate(value.slice(0,10));if(+local[4]>23||+local[5]>59||+(local[6]||0)>59)throw new Error('日程时间无效');return fromWall({y:+local[1],m:+local[2],d:+local[3],h:+local[4],mi:+local[5],s:+(local[6]||0)},zone)/1000}
  }
  const n=value instanceof Date?value.getTime()/1000:typeof value==='number'?(Math.abs(value)>1e11?value/1000:value):Date.parse(String(value))/1000
  if(!Number.isFinite(n))throw new Error('日程时间无效')
  return Math.floor(n)
}
export function calendarPatchFromInput(input:Record<string,unknown>,event:CalEvent):Partial<CalEvent>{
  const patch:Partial<CalEvent>={}
  for(const field of ['title','description','location','url','conferenceUrl','color','status','transparency','visibility','attendees','calendarId'] as const){
    if(field in input)(patch as Record<string,unknown>)[field]=input[field]??undefined
  }
  if('recurrenceRule'in input)patch.rrule=typeof input.recurrenceRule==='string'?input.recurrenceRule.trim()||undefined:undefined
  if('startTz'in input)patch.timeZone=typeof input.startTz==='string'?input.startTz:undefined
  if('endTz'in input)patch.endTimeZone=typeof input.endTz==='string'?input.endTz:undefined
  if('allDay'in input)patch.allDay=!!input.allDay
  if('reminders'in input){
    if(input.reminders==null)patch.reminders=[]
    else if(Array.isArray(input.reminders))patch.reminders=input.reminders.map((r:{offsetMinutes:number;method:'notification'|'sound'})=>({minutes:-r.offsetMinutes,method:r.method}))
    else throw new Error('提醒格式无效')
  }
  const allDay=patch.allDay??event.allDay,zone=patch.timeZone||event.timeZone||systemTimeZone()
  if(input.startDate!==undefined)patch.start=String(input.startDate)
  else if(input.startTime!==undefined){const seconds=calendarSeconds(input.startTime,zone);patch.start=allDay?isoDate(dayOf(seconds*1000,zone)):seconds*1000}
  if(input.endDate!==undefined)patch.end=String(input.endDate)
  else if(input.endTime!==undefined){const seconds=calendarSeconds(input.endTime,patch.endTimeZone||event.endTimeZone||zone);patch.end=allDay?isoDate(dayOf((seconds-1)*1000,zone)+1):seconds*1000}
  return patch
}
export function calendarEventFromInput(input:Record<string,unknown>,calendarId:string):CalEvent{
  const id=newId('event'),now=Date.now()
  const base:CalEvent={id,uid:`${id}@ready.local`,calendarId,title:String(input.title||'').trim(),allDay:!!input.allDay,start:NaN,end:NaN,timeZone:typeof input.startTz==='string'?input.startTz:systemTimeZone(),status:'confirmed',transparency:input.allDay?'transparent':'opaque',createdAt:now,updatedAt:now}
  if(!base.title)throw new Error('请填写日程标题')
  return {...base,...calendarPatchFromInput(input,base)}
}
