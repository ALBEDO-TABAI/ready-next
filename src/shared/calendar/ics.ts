import { color as cssColor } from 'd3-color';
import { customCalendarZone, registerCalendarZone } from './custom-zone';
// iCalendar (RFC 5545) import/export for local events. Original implementation.
import { CalEvent, Attendee, Reminder, newId } from './model';
import { dayNum, isoDate, parseIsoDate } from './dates';
import { fromWall, toWall, isValidTimeZone, UTC } from './tz';

export interface IcsProp { name: string; params: Record<string, string>; value: string }
export interface IcsComp { type: string; props: IcsProp[]; children: IcsComp[] }

export function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.length);
}
function parseLine(line: string): IcsProp {
  let i = 0, inQ = false; let colon = -1;
  for (; i < line.length; i++) { const c = line[i]; if (c === '"') inQ = !inQ; else if (c === ':' && !inQ) { colon = i; break; } }
  const head = colon < 0 ? line : line.slice(0, colon), value = colon < 0 ? '' : line.slice(colon + 1);
  const parts: string[] = []; let cur = ''; inQ = false;
  for (const c of head) { if (c === '"') inQ = !inQ; if (c === ';' && !inQ) { parts.push(cur); cur = ''; } else cur += c; }
  parts.push(cur);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, '').replace(/\^n/gi, '\n').replace(/\^'/g, '"').replace(/\^\^/g, '^'); }
  return { name: parts[0].toUpperCase(), params, value };
}
export function parseIcs(text: string): IcsComp[] {
  const root: IcsComp = { type: 'ROOT', props: [], children: [] }; const stack = [root];
  for (const l of unfold(text)) {
    const p = parseLine(l);
    if (p.name === 'BEGIN') { const c: IcsComp = { type: p.value.toUpperCase(), props: [], children: [] }; stack[stack.length - 1].children.push(c); stack.push(c); }
    else if (p.name === 'END') { if (stack.length <= 1 || stack[stack.length-1].type !== p.value.toUpperCase()) throw new Error('日历文件结构不完整'); stack.pop(); }
    else stack[stack.length - 1].props.push(p);
  }
  if (stack.length !== 1 || !root.children.some(c => c.type === 'VCALENDAR')) throw new Error('日历文件结构不完整');
  return root.children;
}
export const unescapeText = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
export const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Common Windows zone names seen in Outlook exports → IANA
const WINDOWS_TZ: Record<string, string> = {
  'Tokyo Standard Time': 'Asia/Tokyo', 'China Standard Time': 'Asia/Shanghai', 'Taipei Standard Time': 'Asia/Taipei',
  'Pacific Standard Time': 'America/Los_Angeles', 'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris', 'Singapore Standard Time': 'Asia/Singapore', 'Korea Standard Time': 'Asia/Seoul', 'UTC': 'UTC',
};
function resolveTz(tzid: string | undefined, vtz: Map<string, string>): { tz: string } {
  if (!tzid) return { tz: UTC };
  const registered=vtz.get(tzid);if(registered)return {tz:registered};
  const clean = tzid.replace(/^\/+/, '');
  if (isValidTimeZone(clean)) return { tz: clean };
  if (WINDOWS_TZ[clean]) return { tz: WINDOWS_TZ[clean] };
  throw new Error(`未知时区 ${tzid}`);
}
interface DateVal { allDay: boolean; ms?: number; day?: number; tz?: string; floating?: boolean }
function parseDate(p: IcsProp, vtz: Map<string, string>, defaultTz: string): DateVal {
  const v = p.value.trim();
  if (p.params.VALUE === 'DATE' || /^\d{8}$/.test(v)) return { allDay: true, day: parseIsoDate(v) };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) throw new Error('bad date ' + v);
  const wall = { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
  if (m[7]) return { allDay: false, ms: Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s), tz: UTC };
  if (p.params.TZID) {
    const r = resolveTz(p.params.TZID, vtz);
    return { allDay: false, ms: fromWall(wall, r.tz), tz: r.tz };
  }
  return { allDay: false, ms: fromWall(wall, defaultTz), tz: defaultTz, floating: true };
}
function parseDuration(s: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s.trim());
  if (!m) return 0;
  const v = ((+(m[2] || 0)) * 7 * 86400 + (+(m[3] || 0)) * 86400 + (+(m[4] || 0)) * 3600 + (+(m[5] || 0)) * 60 + (+(m[6] || 0))) * 1000;
  return m[1] === '-' ? -v : v;
}


export interface ImportResult { events: CalEvent[]; calendarName?: string; calendarColor?: string; warnings: string[] }
export function importIcs(text: string, calendarId: string, defaultTz: string): ImportResult {
  const comps = parseIcs(text); const warnings: string[] = []; const events: CalEvent[] = [];
  let calendarName: string | undefined, calendarColor: string | undefined;
  const now = Date.now();
  for (const cal of comps.filter((c) => c.type === 'VCALENDAR')) {
    calendarName ??= cal.props.find((p) => p.name === 'X-WR-CALNAME')?.value;
    const rawColor=cal.props.find(p=>p.name==='X-APPLE-CALENDAR-COLOR'||p.name==='COLOR')?.value;
    if(rawColor)calendarColor??=cssColor(rawColor)?.formatHex();
    const vtz = new Map<string, string>();
    const componentText=(c:IcsComp):string=>[`BEGIN:${c.type}`,...c.props.map(p=>`${p.name}${Object.entries(p.params).map(([k,v])=>`;${k}="${v}"`).join('')}:${p.value}`),...c.children.map(componentText),`END:${c.type}`].join('\r\n');
    for (const component of cal.children.filter(c=>c.type==='VTIMEZONE')) {
      const id=component.props.find(p=>p.name==='TZID')?.value;
      if(id)vtz.set(id,registerCalendarZone(componentText(component)));
    }
    const calendarZone=cal.props.find(p=>p.name==='X-WR-TIMEZONE')?.value;
    const fallbackZone=calendarZone?resolveTz(calendarZone,vtz).tz:defaultTz;
    const uidToId = new Map<string, string>();
    const vevents = cal.children.filter((c) => c.type === 'VEVENT');
    // masters first so overrides can reference them
    vevents.sort((a, b) => Number(!!a.props.find((p) => p.name === 'RECURRENCE-ID')) - Number(!!b.props.find((p) => p.name === 'RECURRENCE-ID')));
    for (const ve of vevents) {
      try {
        const g = (n: string) => ve.props.find((p) => p.name === n);
        const ga = (n: string) => ve.props.filter((p) => p.name === n);
        const ds = g('DTSTART'); if (!ds) { warnings.push('VEVENT without DTSTART skipped'); continue; }
        const s = parseDate(ds, vtz, fallbackZone);
        let e: DateVal | undefined; const de = g('DTEND'), du = g('DURATION');
        if (de) e = parseDate(de, vtz, fallbackZone);
        else if (du) e = s.allDay ? { allDay: true, day: s.day! + Math.max(1, Math.round(parseDuration(du.value) / 86400000)) } : { allDay: false, ms: s.ms! + parseDuration(du.value), tz: s.tz };
        else e = s.allDay ? { allDay: true, day: s.day! + 1 } : { ...s };
        const uid = g('UID')?.value?.trim();if(!uid){warnings.push('VEVENT 缺少 UID，不能建立稳定的日程身份');continue;}
        const rid = g('RECURRENCE-ID');
        const id = rid ? newId('ev') : (uidToId.get(uid) ?? newId('ev'));
        const attendees: Attendee[] = ga('ATTENDEE').map((p) => ({
          email: p.value.replace(/^mailto:/i, ''), name: p.params.CN,
          rsvp: ({ ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative' } as Record<string, Attendee['rsvp']>)[(p.params.PARTSTAT || '').toUpperCase()] ?? 'needsAction',
          ...(p.params.ROLE === 'OPT-PARTICIPANT' ? { optional: true } : {}),
        }));
        const org = g('ORGANIZER'); if (org) { const em = org.value.replace(/^mailto:/i, ''); const a = attendees.find((x) => x.email === em); if (a) a.organizer = true; else attendees.unshift({ email: em, name: org.params.CN, rsvp: 'accepted', organizer: true }); }
        const reminders: Reminder[] = ve.children.filter((c) => c.type === 'VALARM').map((a) => {
          const tr = a.props.find((p) => p.name === 'TRIGGER'); const act = a.props.find((p) => p.name === 'ACTION')?.value;
          return { minutes: tr ? Math.round(-parseDuration(tr.value) / 60000) : 0, method: act === 'EMAIL' ? 'email' : act === 'AUDIO' ? 'sound' : 'notification' } as Reminder;
        });
        const ex: (number | string)[] = [];
        for (const p of ga('EXDATE')) for (const v of p.value.split(',')) { const d = parseDate({ ...p, value: v }, vtz, fallbackZone); ex.push(d.allDay ? isoDate(d.day!) : d.ms!); }
        const rd: (number | string)[] = [];
        for (const p of ga('RDATE')) for (const v of p.value.split(',')) { const d = parseDate({ ...p, value: v }, vtz, fallbackZone); rd.push(d.allDay ? isoDate(d.day!) : d.ms!); }
        const status = (g('STATUS')?.value || 'CONFIRMED').toLowerCase();
        const ev: CalEvent = {
          id, uid, calendarId, title: unescapeText(g('SUMMARY')?.value ?? ''),
          description: g('DESCRIPTION') ? unescapeText(g('DESCRIPTION')!.value) : undefined,
          location: g('LOCATION') ? unescapeText(g('LOCATION')!.value) : undefined, url: g('URL')?.value,
          allDay: s.allDay, start: s.allDay ? isoDate(s.day!) : s.ms!, end: e.allDay ? isoDate(e.day!) : e.ms!,
          timeZone: s.allDay ? fallbackZone : s.tz, endTimeZone: e.tz, timeZoneDefinition:s.tz?customCalendarZone(s.tz)?.definition:undefined,endTimeZoneDefinition:e.tz?customCalendarZone(e.tz)?.definition:undefined, rrule: g('RRULE')?.value, exdates: ex.length ? ex : undefined, rdates: rd.length ? rd : undefined,
          conferenceUrl: g('X-READY-CONFERENCE')?.value, color: g('COLOR')?cssColor(g('COLOR')!.value)?.formatHex():undefined,
          status: status === 'cancelled' ? 'cancelled' : status === 'tentative' ? 'tentative' : 'confirmed',
          transparency: g('TRANSP')?.value === 'TRANSPARENT' ? 'transparent' : 'opaque',
          visibility: g('CLASS')?.value === 'PRIVATE' ? 'private' : g('CLASS')?.value === 'PUBLIC' ? 'public' : 'default',
          attendees: attendees.length ? attendees : undefined, reminders: reminders.length ? reminders : undefined,
          createdAt: now, updatedAt: now, sequence: +(g('SEQUENCE')?.value || 0),
        };
        if (rid) {
          const master = uidToId.get(uid);
          if (!master) { warnings.push(`override for unknown series ${uid}`); continue; }
          else { const r = parseDate(rid, vtz, fallbackZone); ev.recurringEventId = master; ev.originalStart = r.allDay ? isoDate(r.day!) : r.ms!; }
        } else uidToId.set(uid, id);
        events.push(ev);
      } catch (err) { warnings.push(String(err)); }
    }
  }
  return { events, calendarName, calendarColor, warnings };
}

const p2 = (n: number) => String(n).padStart(2, '0');
const utcStamp = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`; };
const dateStamp = (iso: string) => iso.replace(/-/g, '');
/** Fold to 75 octets (UTF-8 aware). */
export function fold(line: string): string {
  const enc = new TextEncoder(); if (enc.encode(line).length <= 75) return line;
  const out: string[] = []; let cur = ''; let n = 0; let limit = 75;
  for (const ch of line) { const b = enc.encode(ch).length; if (n + b > limit) { out.push(cur); cur = ''; n = 0; limit = 74; } cur += ch; n += b; }
  out.push(cur); return out.join('\r\n ');
}
export function exportIcs(events: CalEvent[], opt: { calendarName?: string; prodId?: string } = {}): string {
  const L: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${opt.prodId ?? '-//Ready//Ready Calendar//EN'}`, 'CALSCALE:GREGORIAN'];
  if (opt.calendarName) L.push(`X-WR-CALNAME:${escapeText(opt.calendarName)}`);
  const byId = new Map(events.map((e) => [e.id, e]));
  for(const definition of new Set(events.flatMap(e=>[e.timeZoneDefinition,e.endTimeZoneDefinition]).filter((x):x is string=>!!x))){registerCalendarZone(definition);L.push(...definition.split(/\r?\n/).filter(Boolean));}
  const param = (s: string) => '"' + s.replace(/\^/g, '^^').replace(/"/g, "^'").replace(/\r?\n/g, '^n') + '"';
  const dt = (name: string, v: number | string, allDay: boolean, zone?: string) => {
    if (allDay) return `${name};VALUE=DATE:${dateStamp(String(v))}`;
    if (!zone || zone === UTC) return `${name}:${utcStamp(v as number)}`;
    const w = toWall(v as number, zone);
    return `${name};TZID=${param(customCalendarZone(zone)?.name||zone)}:${w.y}${p2(w.m)}${p2(w.d)}T${p2(w.h)}${p2(w.mi)}${p2(w.s)}`;
  };
  for (const e of events) {
    const master = e.recurringEventId ? byId.get(e.recurringEventId) : undefined;
    L.push('BEGIN:VEVENT', `UID:${master?.uid || e.uid}`, `DTSTAMP:${utcStamp(e.updatedAt || Date.now())}`);
    L.push(dt('DTSTART', e.start, e.allDay, e.timeZone), dt('DTEND', e.end, e.allDay, e.endTimeZone || e.timeZone));
    if (e.recurringEventId && e.originalStart !== undefined) L.push(dt('RECURRENCE-ID', e.originalStart, master?.allDay ?? e.allDay, master?.timeZone || e.timeZone));
    if (e.title) L.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.description) L.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.location) L.push(`LOCATION:${escapeText(e.location)}`);
    if (e.url) L.push(`URL:${e.url}`);
    if (e.conferenceUrl) L.push(`X-READY-CONFERENCE:${e.conferenceUrl}`);
    if (e.color) L.push(`COLOR:${e.color}`);
    if (e.rrule) L.push(`RRULE:${e.rrule.replace(/^RRULE:/i, '')}`);
    for (const x of e.exdates ?? []) L.push(dt('EXDATE', x, e.allDay, e.timeZone));
    for (const x of e.rdates ?? []) L.push(dt('RDATE', x, e.allDay, e.timeZone));
    if (e.status !== 'confirmed') L.push(`STATUS:${e.status.toUpperCase()}`);
    if (e.transparency === 'transparent') L.push('TRANSP:TRANSPARENT');
    if (e.visibility === 'private') L.push('CLASS:PRIVATE'); else if (e.visibility === 'public') L.push('CLASS:PUBLIC');
    if (e.sequence) L.push(`SEQUENCE:${e.sequence}`);
    for (const a of e.attendees ?? []) {
      if (a.organizer) L.push(`ORGANIZER${a.name ? `;CN=${param(a.name)}` : ''}:mailto:${a.email}`);
      const ps = { accepted: 'ACCEPTED', declined: 'DECLINED', tentative: 'TENTATIVE', needsAction: 'NEEDS-ACTION' }[a.rsvp];
      L.push(`ATTENDEE${a.name ? `;CN=${param(a.name)}` : ''};PARTSTAT=${ps}${a.optional ? ';ROLE=OPT-PARTICIPANT' : ''}:mailto:${a.email}`);
    }
    for (const r of e.reminders ?? []) L.push('BEGIN:VALARM', `ACTION:${r.method === 'email' ? 'EMAIL' : r.method === 'sound' ? 'AUDIO' : 'DISPLAY'}`, `TRIGGER:${r.minutes >= 0 ? '-' : ''}PT${Math.abs(r.minutes)}M`, 'DESCRIPTION:Reminder', 'END:VALARM');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
export { dayNum };
