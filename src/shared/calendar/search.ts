import { findCalendarOccurrence } from './commands'
import { occurrences, isRecurring, type CalEvent, type Occurrence } from './model'

/** Search stored records, including hidden calendars and dates outside the current year. */
export function searchCalendar(events:CalEvent[],query:string,day:number,zone:string):Occurrence[]{
  const q=query.trim().toLocaleLowerCase();if(!q)return[]
  const matches=(e:CalEvent)=>[e.title,e.description,e.location,e.url,e.conferenceUrl,...(e.attendees||[]).flatMap(a=>[a.email,a.name])].join(' ').toLocaleLowerCase().includes(q)
  const found:Occurrence[]=[]
  for(const event of events){
    if(!matches(event))continue
    const key=event.recurringEventId?`${event.recurringEventId}|${event.originalStart}`:event.id
    const next=isRecurring(event)?occurrences(events.filter(e=>e.id===event.id||e.recurringEventId===event.id),day,day+366,zone).find(o=>matches(o.event)):undefined
    const result=next||findCalendarOccurrence(events,key,zone)
    if(result&&matches(result.event)&&!found.some(o=>o.key===result.key))found.push(result)
  }
  return found.sort((a,b)=>a.start-b.start).slice(0,200)
}
