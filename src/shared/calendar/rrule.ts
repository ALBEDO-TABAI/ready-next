import * as rruleModule from 'rrule';
const recurrenceLibrary = (rruleModule as unknown as { default?: typeof rruleModule }).default || rruleModule;
// RFC 5545 recurrence rules: parse, serialise, expand. Original implementation.
// Expansion runs on wall-clock dates in the event's zone (or floating for all-day) and converts to instants.
import { DayNum, dayNum, ymd, weekday, daysInMonth, startOfWeek, isLeap } from './dates';
import { fromWall, toWall, UTC } from './tz';

export type Freq = 'SECONDLY' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export interface ByDay { wd: number; n?: number }
export interface RRule {
  freq: Freq; interval: number; count?: number;
  /** UNTIL as epoch ms (timed) or day number (all-day) */
  until?: number; untilIsDate?: boolean;
  byDay?: ByDay[]; byMonthDay?: number[]; byMonth?: number[]; byYearDay?: number[]; byWeekNo?: number[];
  bySetPos?: number[]; byHour?: number[]; byMinute?: number[]; bySecond?: number[]; wkst: number;
}

export function parseRRule(src: string): RRule {
  const s = src.replace(/^RRULE:/i, '').trim();
  const r: RRule = { freq: 'DAILY', interval: 1, wkst: 1 };
  const nums = (v: string) => v.split(',').filter(Boolean).map(Number);
  for (const part of s.split(';')) {
    const [k0, v = ''] = part.split('='); const k = k0.toUpperCase();
    switch (k) {
      case 'FREQ': r.freq = v.toUpperCase() as Freq; break;
      case 'INTERVAL': r.interval = Math.max(1, +v || 1); break;
      case 'COUNT': r.count = +v; break;
      case 'UNTIL': {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
        if (m) {
          if (m[4] === undefined) { r.until = dayNum(+m[1], +m[2], +m[3]); r.untilIsDate = true; }
          else r.until = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        }
        break;
      }
      case 'BYDAY': r.byDay = v.split(',').filter(Boolean).map((x) => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(x.trim())!; return { wd: WD.indexOf(m[2].toUpperCase() as typeof WD[number]), n: m[1] ? +m[1] : undefined }; }); break;
      case 'BYMONTHDAY': r.byMonthDay = nums(v); break;
      case 'BYMONTH': r.byMonth = nums(v); break;
      case 'BYYEARDAY': r.byYearDay = nums(v); break;
      case 'BYWEEKNO': r.byWeekNo = nums(v); break;
      case 'BYSETPOS': r.bySetPos = nums(v); break;
      case 'BYHOUR': r.byHour = nums(v); break;
      case 'BYMINUTE': r.byMinute = nums(v); break;
      case 'BYSECOND': r.bySecond = nums(v); break;
      case 'WKST': r.wkst = Math.max(0, WD.indexOf(v.toUpperCase() as typeof WD[number])); break;
    }
  }
  return r;
}

const p2 = (n: number) => String(n).padStart(2, '0');
export function formatUntil(r: RRule): string | undefined {
  if (r.until === undefined) return undefined;
  if (r.untilIsDate) { const d = ymd(r.until); return `${d.y}${p2(d.m)}${p2(d.d)}`; }
  const d = new Date(r.until);
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}
export function stringifyRRule(r: RRule): string {
  const out = [`FREQ=${r.freq}`];
  if (r.interval > 1) out.push(`INTERVAL=${r.interval}`);
  if (r.count !== undefined) out.push(`COUNT=${r.count}`);
  const u = formatUntil(r); if (u) out.push(`UNTIL=${u}`);
  if (r.byDay?.length) out.push(`BYDAY=${r.byDay.map((b) => (b.n ? b.n : '') + WD[b.wd]).join(',')}`);
  if (r.byMonthDay?.length) out.push(`BYMONTHDAY=${r.byMonthDay.join(',')}`);
  if (r.byMonth?.length) out.push(`BYMONTH=${r.byMonth.join(',')}`);
  if (r.byYearDay?.length) out.push(`BYYEARDAY=${r.byYearDay.join(',')}`);
  if (r.byWeekNo?.length) out.push(`BYWEEKNO=${r.byWeekNo.join(',')}`);
  if (r.bySetPos?.length) out.push(`BYSETPOS=${r.bySetPos.join(',')}`);
  if (r.byHour?.length) out.push(`BYHOUR=${r.byHour.join(',')}`);
  if (r.byMinute?.length) out.push(`BYMINUTE=${r.byMinute.join(',')}`);
  if (r.bySecond?.length) out.push(`BYSECOND=${r.bySecond.join(',')}`);
  if (r.wkst !== 1) out.push(`WKST=${WD[r.wkst]}`);
  return out.join(';');
}

export interface ExpandInput {
  rule: RRule | string; dtstart: number; allDay: boolean; timeZone?: string;
  exdates?: number[]; rdates?: number[];
}

// rrule enumerates civil clock fields; only this boundary converts them to instants.
// Main queries, reminders and the renderer all use this same implementation.
export function expand(inp: ExpandInput, from: number, to: number, limit = 20000): number[] {
  if (!(from < to)) return [];
  const zone = inp.timeZone || UTC;
  const wallStamp = (ms: number) => { const w = toWall(ms, zone); return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s); };
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const start = inp.allDay ? inp.dtstart * 86400000 : wallStamp(inp.dtstart);
  let body = typeof inp.rule === 'string' ? inp.rule.trim() : stringifyRRule(inp.rule);
  body = body.split(/\r?\n/).find(line => /^(RRULE:)?FREQ=/i.test(line))?.replace(/^RRULE:/i, '') || '';
  if (!body) throw new Error('无效的重复规则');
  for(const token of body.split(';')){
    const [key,number]=token.split('=');
    if(['INTERVAL','COUNT'].includes(key.toUpperCase())&&(!/^\d+$/.test(number||'')||!Number.isSafeInteger(Number(number))||Number(number)<1))throw new Error('重复间隔和次数必须是正整数');
  }
  if(inp.allDay){if(/FREQ=(HOURLY|MINUTELY|SECONDLY)/i.test(body))throw new Error('全天日程需要按日或更长周期重复');body=body.replace(/;BY(HOUR|MINUTE|SECOND)=[^;]+/gi,'');}
  // UTC UNTIL limits an instant, while the enumerator operates on civil fields.
  if (!inp.allDay) body = body.replace(/UNTIL=(\d{8}T\d{6})Z/i, (_match, value: string) => {
    const ms = Date.UTC(+value.slice(0,4), +value.slice(4,6)-1, +value.slice(6,8), +value.slice(9,11), +value.slice(11,13), +value.slice(13,15));
    return 'UNTIL=' + stamp(wallStamp(ms));
  });
  if(!inp.allDay)body=body.replace(/UNTIL=(\d{8})(?=;|$)/i,'UNTIL=$1T235959Z');
  const rule = recurrenceLibrary.rrulestr(`DTSTART:${stamp(start)}\nRRULE:${body}`);
  const lo = inp.allDay ? from * 86400000 : wallStamp(from) - 86400000;
  const hi = inp.allDay ? to * 86400000 : wallStamp(to) + 86400000;
  const candidates = rule.between(new Date(Math.max(-8640000000000000,lo)), new Date(Math.min(8640000000000000,hi)), true, (_date: Date, i: number) => i <= limit);
  if (candidates.length > limit) throw new Error('重复日程过多，请缩小查询范围');
  const values = candidates.map((date: Date) => {
    if (inp.allDay) return date.getTime() / 86400000;
    return fromWall({ y: date.getUTCFullYear(), m: date.getUTCMonth()+1, d: date.getUTCDate(), h: date.getUTCHours(), mi: date.getUTCMinutes(), s: date.getUTCSeconds() }, zone);
  });
  const excluded = new Set(inp.exdates || []);
  return [...new Set([...values, ...(inp.rdates || [])])].filter(n => n >= from && n < to && !excluded.has(n)).sort((a,b) => a-b);
}

/** Human description used in the repeat picker ("Every week on Mon, Wed"). */
export function describe(r: RRule, names = { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }): string {
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year', HOURLY: 'hour', MINUTELY: 'minute', SECONDLY: 'second' }[r.freq];
  let s = r.interval > 1 ? `Every ${r.interval} ${unit}s` : `Every ${unit}`;
  if (r.byDay?.length) s += ' on ' + r.byDay.map((b) => (b.n ? `${b.n === -1 ? 'last' : ordinal(b.n)} ` : '') + names.day[b.wd]).join(', ');
  if (r.byMonthDay?.length) s += ' on day ' + r.byMonthDay.join(', ');
  if (r.count) s += `, ${r.count} times`;
  return s;
}
function ordinal(n: number): string { return ['', '1st', '2nd', '3rd', '4th', '5th'][n] ?? `${n}th`; }
