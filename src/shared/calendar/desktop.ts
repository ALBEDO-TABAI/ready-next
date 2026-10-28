import { parseIsoDate } from './dates'
export type CalendarNavigation =
  | { kind:'event'; eventId:string }
  | { kind:'day'; date:string }
  | { kind:'command'; command:'create'|'settings'|'search'|'day'|'week'|'month' }
export interface CalendarNavigationRequest { id:string; target:CalendarNavigation }
export function parseCalendarDeepLink(raw:string):CalendarNavigation|null {
  const url=new URL(raw)
  if(url.protocol!=='ready:'||url.hostname!=='calendar')return null
  const [kind,...parts]=url.pathname.slice(1).split('/'),value=decodeURIComponent(parts.join('/'))
  if(kind==='day'){parseIsoDate(value);return {kind:'day',date:value}}
  if(kind==='event'&&value)return {kind:'event',eventId:value}
  return null
}
