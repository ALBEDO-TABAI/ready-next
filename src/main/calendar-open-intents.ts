// Pre-ready OS intents only. No Electron, database, filesystem or renderer dependency.
export interface CalendarOpenIntent {kind:'file'|'url';value:string}
const pending:CalendarOpenIntent[]=[]
let consumer:((intent:CalendarOpenIntent)=>void)|null=null
export function captureCalendarOpen(intent:CalendarOpenIntent):boolean {
  if(intent.kind==='file'?!/\.(ics|vcs)$/i.test(intent.value):!intent.value.startsWith('ready://calendar/'))return false
  if(consumer)consumer(intent);else pending.push(intent)
  return true
}
export function consumeCalendarOpens(handler:(intent:CalendarOpenIntent)=>void):()=>void {
  consumer=handler;pending.splice(0).forEach(handler)
  return ()=>{consumer=null}
}
