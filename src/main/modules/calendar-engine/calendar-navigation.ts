import { randomUUID } from 'node:crypto'
import type { CalendarNavigation, CalendarNavigationRequest } from '../../../shared/calendar/desktop'
let pending:CalendarNavigationRequest|null=null
const listeners=new Set<()=>void>()
export function requestCalendarNavigation(target:CalendarNavigation):void {pending={id:randomUUID(),target};for(const notify of listeners)notify()}
export function peekCalendarNavigation(){return pending}
export function acknowledgeCalendarNavigation(id:string):void {if(pending?.id===id)pending=null}
export function onCalendarNavigation(listener:()=>void):()=>void {listeners.add(listener);return()=>{listeners.delete(listener)}}
