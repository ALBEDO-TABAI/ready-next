// App state: a tiny observable store with actions. Original implementation.
import { useSyncExternalStore, useRef } from 'react';
import {
  CalEvent, Calendar, Account, Occurrence, isRecurring, DayNum, occurrences, newId, systemTimeZone, dayOf, startOfWeek, addMonths, startOfMonth,
  ymd, parseIsoDate, isoDate, importIcs, exportIcs, parseRRule, stringifyRRule, toWall, fromWall,
} from '@shared/calendar';
import { api, unwrap } from './platform';
import { findCalendarOccurrence, splitOccurrenceKey, rebaseCalendarHistory, type CalendarCommand, type CalendarSnapshot, type CalendarMutationReceipt, type CalendarDelta } from '@shared/calendar/commands';
import { useTheme } from '../../../stores/useTheme';
import { Locale, setLocale, t } from './i18n';

import type { CalendarLayer } from '../../../../shared/calendar-layers';

export type GridView = 'default' | 'month';
export interface Prefs {
  layers: Record<CalendarLayer, boolean>;
  gridView: GridView; daysPerPeriod: number; densityZoomLevel: number; weekStartsOn: number;
  showWeekends: boolean; showDeclined: boolean; showWeekNumbers: boolean; format24HourTime: boolean;
  interfaceTheme: 'system' | 'light' | 'dark'; contextPanel: boolean;
  primaryTimeZone: string; additionalTimeZones: string[]; locale: Locale; localeChosen?: boolean; defaultEventDuration: number;
  collapseAllDaySection: boolean; todayKey: 'today' | 'alignToday';
  upcomingHours: number; mapsProvider: 'google' | 'apple' | 'osm'; openAtLogin: boolean; showAdditionalTz: boolean;
  notifications: boolean; defaultReminder: number; defaultAllDayReminder: number; notifySound: boolean; menuBarNext: boolean; menuBarMaxLen: number;
  displayName: string; email: string; videoProvider: 'none' | 'meet' | 'zoom' | 'teams' | 'custom'; videoUrl: string; autoAddVideo: boolean;
}
export const defaultPrefs = (): Prefs => ({
  layers: { events: true, documents: true, tasks: true, footprints: true },
  gridView: 'default', daysPerPeriod: 7, densityZoomLevel: 0, weekStartsOn: 0, showWeekends: true, showDeclined: true, showWeekNumbers: false,
  format24HourTime: false, interfaceTheme: 'system', contextPanel: true, primaryTimeZone: systemTimeZone(), additionalTimeZones: [],
  locale: 'zh-CN', defaultEventDuration: 30, collapseAllDaySection: false, todayKey: 'today',
  upcomingHours: 4, mapsProvider: 'google', openAtLogin: false, showAdditionalTz: true,
  notifications: true, defaultReminder: 10, defaultAllDayReminder: -1, notifySound: true, menuBarNext: true, menuBarMaxLen: 32,
  displayName: '', email: '', videoProvider: 'none', videoUrl: '', autoAddVideo: false,
});
export type Overlay = null | 'shortcuts' | 'search' | 'goto' | 'recurrence';
export interface MenuState { kind: 'view' | 'chip' | 'grid' | 'calendar' | 'repeat' | 'busy' | 'visibility' | 'reminder' | 'calendarPick' | 'time' | 'tz' | 'color' | 'evColor' | 'recurrence'; x: number; y: number; data?: any }
export interface Toast { id: number; text: string; undo?: () => void }
export interface ScopeAsk { kind: 'edit' | 'delete'; resolve: (s: 'this' | 'following' | 'all' | null) => void }
export interface State {
  ready: boolean; busy: boolean; error: string | null; prefs: Prefs; accounts: Account[]; calendars: Calendar[]; events: Record<string, CalEvent>;
  anchor: DayNum; today: DayNum; now: number; systemDark: boolean;
  selected: string[]; editing: string | null; draftId: string | null; focusTitle: number;
  overlay: Overlay; menu: MenuState | null; toasts: Toast[]; scopeAsk: ScopeAsk | null; settingsPage: string; recKey: string | null; avail: { active: boolean; slots: { start: number; end: number }[]; duration: number };
  minDensity: number; cursorDay: DayNum; clipboard: CalEvent[]; searchQuery: string;
}
const tzNow = () => dayOf(Date.now(), systemTimeZone());
let state: State = {
  ready: false, busy: false, error: null, prefs: defaultPrefs(), accounts: [], calendars: [], events: {}, anchor: tzNow(), today: tzNow(), now: Date.now(),
  systemDark: typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches,
  selected: [], editing: null, draftId: null, focusTitle: 0, overlay: null, menu: null, toasts: [], scopeAsk: null, settingsPage: 'general', recKey: null, avail: { active: false, slots: [], duration: 30 },
  minDensity: -4, cursorDay: tzNow(), clipboard: [], searchQuery: '',
};
const subs = new Set<() => void>();
export const getState = () => state;
export function setState(p: Partial<State> | ((s: State) => Partial<State>)) {
  const patch = typeof p === 'function' ? p(state) : p;
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}
export function subscribe(f: () => void) { subs.add(f); return () => subs.delete(f); }
export function useStore<T>(sel: (s: State) => T): T {
  const ref = useRef<{ s: State; v: T } | null>(null);
  return useSyncExternalStore(subscribe, () => {
    if (ref.current && ref.current.s === state) return ref.current.v;
    const v = sel(state);
    if (ref.current && shallowEq(ref.current.v, v)) { ref.current.s = state; return ref.current.v; }
    ref.current = { s: state, v }; return v;
  });
}
function shallowEq(a: any, b: any) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b); if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

// ---------- derived ----------
export const tz = () => state.prefs.primaryTimeZone;
export const isDark = (s = state) => (s.prefs.interfaceTheme === 'system' ? s.systemDark : s.prefs.interfaceTheme === 'dark');
export function periodDays(s = state): DayNum[] {
  const p = s.prefs;
  if (p.gridView === 'month') return [];
  const n = p.daysPerPeriod;
  const first = n === 7 ? startOfWeek(s.anchor, p.weekStartsOn) : s.anchor;
  const out = Array.from({length:n},(_,i)=>first+i).filter(d=>p.showWeekends || n!==7 || ![0,6].includes(((d%7)+11)%7));
  return out;
}
export function monthRange(s = state): { first: DayNum; weeks: number; month: number } {
  const m0 = startOfMonth(s.anchor); const first = startOfWeek(m0, s.prefs.weekStartsOn);
  const { y, m } = ymd(m0); const last = parseIsoDate(`${y}-${String(m).padStart(2, '0')}-01`) + new Date(Date.UTC(y, m, 0)).getUTCDate() - 1;
  const weeks = Math.ceil((last - first + 1) / 7);
  return { first, weeks: Math.max(weeks, 5), month: m };
}
export function visibleCalendars(s = state) { return new Set(s.calendars.filter((c) => c.visible).map((c) => c.id)); }
export function calendarOf(id: string) { return state.calendars.find((c) => c.id === id); }
export function occurrencesIn(from: DayNum, to: DayNum, s = state): Occurrence[] {
  if (!s.prefs.layers.events) return [];
  const vis = visibleCalendars(s);
  const evs = Object.values(s.events).filter((e) => vis.has(e.calendarId));
  return occurrences(evs, from, to, s.prefs.primaryTimeZone).filter((o) => s.prefs.showDeclined || !o.event.attendees?.some((a) => a.self && a.rsvp === 'declined'));
}
export function findOccurrence(key: string, s = state): Occurrence | undefined { return findCalendarOccurrence(Object.values(s.events), key, s.prefs.primaryTimeZone); }
export const splitKey = splitOccurrenceKey;

let generation = 0;
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
function receive(snapshot: CalendarSnapshot) {
  const prefs = { ...defaultPrefs(), ...snapshot.prefs, ...(state.ready ? { contextPanel: state.prefs.contextPanel } : {}), interfaceTheme: useTheme.getState().theme, openAtLogin: state.prefs.openAtLogin } as Prefs;
  // The calendar follows Ready's interface language; a locale it detected on its own earlier is not a choice.
  if (prefs.locale !== 'zh-CN' && !prefs.localeChosen) prefs.locale = 'zh-CN'
  setLocale(prefs.locale);
  setState({ ready: true, calendars: snapshot.calendars, events: Object.fromEntries(snapshot.events.map(e=>[e.id,e])), prefs,
    accounts: [{id:'local',kind:'local',name:'本地日历'}, ...(snapshot.calendars.some(c=>c.syncUrl) ? [{id:'subscriptions',kind:'ics' as const,name:'订阅日历'}] : [])] });
}
export async function reload() {
  const request = ++generation;
  try { const snapshot = await unwrap(api().snapshot()); if(request === generation && !pending)receive(snapshot); }
  catch(error){ console.warn('[CalendarStore] reload snapshot failed:', error instanceof Error ? error.message : String(error));setState({error:error instanceof Error?error.message:String(error)})}
}
export async function init() { const first=!state.ready;await reload(); const today=dayOf(Date.now(),tz());setState({today,...(first?{anchor:today,cursorDay:today}:{})}); }
function execute<T>(fn:()=>Promise<T>):Promise<T|undefined> {
  ++pending;++generation;setState({busy:true,error:null});
  const run=queue.then(fn).catch(error=>{const message=error instanceof Error?error.message:String(error);setState({error:message});toast(message);return undefined}).finally(()=>{--pending;setState({busy:pending>0});if(!pending)void reload()});
  queue=run;return run;
}
const versions=()=>Object.fromEntries(Object.values(state.events).map(e=>[e.id,e.revision||1]));
const history=(r:CalendarMutationReceipt):CalendarMutationReceipt=>({...r,snapshot:{...r.snapshot,events:r.snapshot.events.filter(e=>r.changedIds.includes(e.id))},versions:Object.fromEntries(r.changedIds.map(id=>[id,r.versions[id]||0]))});
const undoStack:CalendarMutationReceipt[]=[];const redoStack:CalendarMutationReceipt[]=[];
async function mutate(command:CalendarCommand,expected=versions()) {
  return execute(async()=>{const result=await unwrap(api().mutate(command,expected));receive(result.snapshot);undoStack.push(history(result));if(undoStack.length>100)undoStack.shift();redoStack.length=0;return result;});
}
export async function applyBatch(delta:CalendarDelta) {
  return execute(async()=>{const result=await unwrap(api().restore(delta,versions()));receive(result.snapshot);undoStack.push(history(result));redoStack.length=0;return result;});
}

export function undo() { return execute(async()=>{const previous=undoStack.at(-1);if(!previous)return;const result=await unwrap(api().restore(previous.undo,previous.versions));receive(result.snapshot);undoStack.pop();rebaseCalendarHistory(undoStack,result);redoStack.push(history(result));}); }
export function redo() { return execute(async()=>{const previous=redoStack.at(-1);if(!previous)return;const result=await unwrap(api().restore(previous.undo,previous.versions));receive(result.snapshot);redoStack.pop();rebaseCalendarHistory(redoStack,result);undoStack.push(history(result));}); }
export function setPrefs(p:Partial<Prefs>) {
  return execute(async()=>{
    const {interfaceTheme,openAtLogin,...prefs}=p;
    if(interfaceTheme)useTheme.getState().setTheme(interfaceTheme);
    const login=openAtLogin===undefined?state.prefs.openAtLogin:await unwrap(api().setLoginItem(openAtLogin));
    const snapshot=await unwrap(api().putPreferences(prefs as Record<string,unknown>));
    receive(snapshot);
    setState(s=>({prefs:{...s.prefs,...(p.contextPanel===undefined?{}:{contextPanel:p.contextPanel}),openAtLogin:login}}));
  });
}
export function setView(gridView:GridView,days?:number){void setPrefs({gridView,...(days?{daysPerPeriod:days}:{})});setState({menu:null})}
export function goToday(){setState(s=>({anchor:s.today,cursorDay:s.today}))}
export function goToDay(d:DayNum){setState({anchor:d,cursorDay:d})}
export function step(dir:1|-1){const p=state.prefs;setState({anchor:p.gridView==='month'?addMonths(startOfMonth(state.anchor),dir):(p.daysPerPeriod===7?startOfWeek(state.anchor,p.weekStartsOn):state.anchor)+dir*p.daysPerPeriod})}
export function zoom(d:1|-1|0){void setPrefs({densityZoomLevel:d===0?0:Math.max(state.minDensity,Math.min(20,state.prefs.densityZoomLevel+d))})}
export function openOverlay(overlay:Overlay){setState({overlay,menu:null,prefs:{...state.prefs,contextPanel:overlay==='search'||overlay==='shortcuts'||state.prefs.contextPanel}})}
// The calendar's preferences are a section of the global settings page (W2 §3.2); `page` picks its sub-page.
export function openCalendarSettings(page?: string) { if (page) setState({ settingsPage: page }); window.location.hash = '#/settings?section=calendar'; }
export function openMenu(menu:MenuState|null){const rect=document.querySelector('.ready-calendar')?.getBoundingClientRect();setState({menu:menu&&rect?{...menu,x:menu.x-rect.left,y:menu.y-rect.top}:menu})}
let toastSeq=0;
export function toast(text:string,undo?:()=>void){const id=++toastSeq;setState(s=>({toasts:[...s.toasts.slice(-2),{id,text,undo}]}));window.setTimeout(()=>setState(s=>({toasts:s.toasts.filter(x=>x.id!==id)})),5000)}
export function primaryCalendar(){return state.calendars.find(c=>c.primary&&!c.readOnly)||state.calendars.find(c=>!c.readOnly)}
function makeEvent(p:Partial<CalEvent>&{start:number|string;end:number|string;allDay:boolean}):CalEvent{
  const id=newId('event'),now=Date.now(),minutes=p.allDay?state.prefs.defaultAllDayReminder:state.prefs.defaultReminder;
  const calendarId=p.calendarId||primaryCalendar()?.id;if(!calendarId)throw new Error('请先创建本地日历');
  return {id,uid:`${id}@ready.local`,calendarId,title:'',status:'confirmed',transparency:p.allDay?'transparent':'opaque',timeZone:tz(),createdAt:now,updatedAt:now,reminders:minutes>=0?[{minutes,method:'notification'}]:[],...p};
}
export async function createEvent(p:Partial<CalEvent>&{start:number|string;end:number|string;allDay:boolean},opts:{select?:boolean;draft?:boolean}={}){
  let event:CalEvent;try{event=makeEvent(p)}catch(error){ console.warn('[CalendarStore] prepare event failed:', error instanceof Error ? error.message : String(error));toast(String(error));return undefined}
  const result=await mutate({type:'create',event});if(!result)return undefined;
  if(opts.select!==false)setState(s=>({selected:[event.id],editing:event.id,draftId:opts.draft?event.id:null,focusTitle:s.focusTitle+1,overlay:null,menu:null,prefs:{...s.prefs,contextPanel:true}}));
  return event.id;
}
export async function createEvents(items:Array<Partial<CalEvent>&{start:number|string;end:number|string;allDay:boolean}>){return applyBatch({put:items.map(makeEvent),remove:[]})}
export function settleDraft(next:string|null){const id=state.draftId;if(!id||id===next)return;setState({draftId:null});void execute(async()=>{const e=state.events[id];if(e&&!e.title.trim()){const result=await unwrap(api().mutate({type:'delete',keys:[id],scope:'all'},versions()));receive(result.snapshot);const i=undoStack.findIndex(r=>r.undo.remove.includes(id));if(i>=0)undoStack.splice(i,1)}})}
export function select(keys:string[],opts:{additive?:boolean;edit?:boolean}={}){const selected=opts.additive?[...new Set([...state.selected,...keys])]:keys;settleDraft(selected[0]||null);setState({selected,editing:opts.edit===false?state.editing:selected.length===1?selected[0]:selected.length?state.editing:null,menu:null,prefs:{...state.prefs,contextPanel:(opts.edit!==false&&selected.length===1)||state.prefs.contextPanel}})}
export function clearSelection(){settleDraft(null);setState({selected:[],editing:null,menu:null})}
async function askScope(kind:'edit'|'delete'):Promise<'this'|'following'|'all'|null>{return new Promise(resolve=>setState({scopeAsk:{kind,resolve:value=>{setState({scopeAsk:null});resolve(value)}}}))}
export async function updateOccurrence(key:string,patch:Partial<CalEvent>,opts:{scope?:'this'|'following'|'all';label?:string;expectedRevision?:number}={}){
  const o=findOccurrence(key);if(!o){toast('日程已变化，请重新选择');return;}const expected=versions();expected[o.seriesId||o.event.id]=opts.expectedRevision??o.event.revision??1;const scope=(o.seriesId||isRecurring(o.event))?opts.scope||await askScope('edit'):undefined;if((o.seriesId||isRecurring(o.event))&&!scope)return;
  const result=await mutate({type:'update',key,patch,scope:scope||undefined},expected);if(result){let nextKey=key;if(scope==='following'){nextKey=result.undo.remove.find(id=>result.snapshot.events.some(e=>e.id===id&&!e.recurringEventId))||key}else if(scope==='all'&&patch.start!==undefined){const parent=o.seriesId||o.event.id;const original=patch.start;nextKey=`${parent}|${original}`}const target=findOccurrence(nextKey);if(target&&(state.editing===key||state.selected.includes(key)))select([target.key]);return ()=>{void undo()}}return undefined;
}
export async function deleteOccurrences(keys:string[],opts:{scope?:'this'|'following'|'all';silent?:boolean}={}){
  const expected=versions();const recurring=keys.some(key=>{const o=findOccurrence(key);return o&&(o.seriesId||isRecurring(o.event))});const scope=recurring?opts.scope||await askScope('delete'):undefined;if(recurring&&!scope)return;
  const result=await mutate({type:'delete',keys,scope:scope||undefined},expected);if(result){setState({selected:[],editing:null,draftId:null});if(!opts.silent)toast(t('deleted'),()=>{void undo()})}
}
export async function duplicateOccurrences(keys:string[]){const result=await mutate({type:'duplicate',keys});if(result)select(result.undo.remove)}
export async function copyOccurrences(keys:string[],cut=false){
  const events=keys.map(key=>findOccurrence(key)).filter((o):o is Occurrence=>!!o).map(o=>{const {rrule,exdates,rdates,recurringEventId,originalStart,...e}=o.event;return {...e,start:o.allDay?isoDate(o.startDay):o.start,end:o.allDay?isoDate(o.endDay+1):o.end}});
  setState({clipboard:events});if(cut)await deleteOccurrences(keys,{scope:'this',silent:true});
}
export async function paste(){
  if(!state.clipboard.length)return;
  const day0=Math.min(...state.clipboard.map(e=>e.allDay?parseIsoDate(String(e.start)):dayOf(Number(e.start),tz()))),delta=state.cursorDay-day0;
  const made=state.clipboard.map(e=>{const {id,uid,revision,...p}=e;if(e.allDay)return makeEvent({...p,start:isoDate(parseIsoDate(String(e.start))+delta),end:isoDate(parseIsoDate(String(e.end))+delta)});const w=toWall(Number(e.start),tz()),d=ymd(dayOf(Number(e.start),tz())+delta),start=fromWall({...w,...d},tz());return makeEvent({...p,start,end:start+Number(e.end)-Number(e.start)})});
  const result=await applyBatch({put:made,remove:[]});if(result)select(made.map(e=>e.id));
}
export async function updateCalendar(id:string,patch:Partial<Calendar>){return execute(async()=>{const c=state.calendars.find(c=>c.id===id);if(!c)return false;receive(await unwrap(api().putCalendar({...c,...patch})));return true})}
export async function addCalendar(name:string,color:string){const id=newId('cal');const result=await execute(async()=>{receive(await unwrap(api().putCalendar({id,accountId:'local',name,color,visible:true,order:state.calendars.length})));return id});return result}
export async function removeCalendar(id:string){return execute(async()=>{receive(await unwrap(api().deleteCalendar(id)))})}
export async function importIcsText(text:string,name='Imported',sourceId?:string){return execute(async()=>{const result=await unwrap(api().importCalendar(text,name,sourceId));receive(await unwrap(api().snapshot()));toast(t('imported',{n:result.created+result.updated}))})}
export async function importIcsFile(){try{const file=await unwrap(api().openIcs());if(file)await importIcsText(file.text,file.name,file.sourceId)}catch(error){ console.warn('[CalendarStore] import ICS file failed:', error instanceof Error ? error.message : String(error));toast(String(error))}}
export async function exportCalendar(id?:string){try{const raw=await unwrap(api().exportIcs(id));await unwrap(api().saveIcs(`${calendarOf(id||'')?.name||'Ready'}.ics`,raw))}catch(error){ console.warn('[CalendarStore] export ICS file failed:', error instanceof Error ? error.message : String(error));toast(String(error))}}

export async function showOnlyCalendar(id:string){return execute(async()=>{receive(await unwrap(api().putCalendars(state.calendars.map(c=>({...c,visible:c.id===id})))));return true})}
export async function syncCalendar(id:string){return execute(async()=>{const result=await unwrap(api().syncSourceNow(id));receive(await unwrap(api().snapshot()));toast(`已同步 ${result.eventsCreated+result.eventsUpdated} 条日程`);return true})}
