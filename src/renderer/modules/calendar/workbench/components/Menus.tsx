// The calendar's menus: view switcher, chip and grid context menus, the event panel's pickers and the calendar
// menu. All of them are the shared menu (MenuList) in the app's float layer; the colour row is the only part that
// is the calendar's own (event colours are calendar data).
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Scissors, Copy, CopyPlus, Trash2, ClipboardPaste, Plus } from 'lucide-react';
import { PALETTE, colorFamily, parseRRule, stringifyRRule, weekday, ymd, fromWall, isoDate, dayOf, toWall } from '@shared/calendar';
import { MenuList, type MenuEntry } from '../../../../components/ui/float/Menu';
import { Input } from '../../../../components/ui/Field';
import { confirmDialog } from '../../../../components/ui/float/Dialog';
import type { FloatAnchor } from '../../../../components/ui/float/float-store';
import { getState, setState, setView, setPrefs, findOccurrence, updateOccurrence, deleteOccurrences, duplicateOccurrences, copyOccurrences, paste, createEvent, calendarOf, updateCalendar, removeCalendar, addCalendar, exportCalendar, syncCalendar, showOnlyCalendar, isDark } from '../store';
import { t } from '../i18n';
import { MOD } from '../commands';
import { wdShort, monthName, panelTime, ruleLabel, REMINDER_OPTS, reminderLabel } from '../fmt';
import { anchorAt, openCalendarFloat, type At } from '../floats';
import { openRecurrenceDialog } from './Overlays';

export type MenuKind = 'view' | 'chip' | 'grid' | 'calendar' | 'calendarPick' | 'busy' | 'visibility' | 'reminder' | 'repeat' | 'evColor' | 'time' | 'tz';

/** Opens one of the calendar's menus at a point or under a control. `data.key` names the occurrence. */
export interface MenuData { key?: string; id?: string; create?: boolean; day?: number; min?: number; allDay?: boolean; edge?: 'start' | 'end' }
export function openCalendarMenu(kind: MenuKind, at: At, data: MenuData = {}): void {
  const anchor = anchorAt(at);
  const occ = data.key ? findOccurrence(data.key) : undefined;
  const revision = { expectedRevision: occ?.event.revision };
  switch (kind) {
    case 'view': return viewMenu(anchor);
    case 'chip': return void (data.key && chipMenu(anchor, data.key));
    case 'grid': {
      const { day = getState().cursorDay, min = 0, allDay } = data; const p = getState().prefs;
      return menu(anchor, [
        { id: 'new', label: t('newEvent'), icon: <Plus />, hint: 'C', onSelect: () => {
          if (allDay) void createEvent({ allDay: true, start: isoDate(day), end: isoDate(day + 1) }, { draft: true });
          else { const st = fromWall({ ...ymd(day), h: Math.floor(min / 60), mi: min % 60 }, p.primaryTimeZone); void createEvent({ allDay: false, start: st, end: st + p.defaultEventDuration * 60000 }, { draft: true }); }
        } },
        { id: 'paste', label: t('paste'), icon: <ClipboardPaste />, hint: `${MOD} V`, disabled: !getState().clipboard.length, onSelect: () => { setState({ cursorDay: day }); paste(); } },
      ], t('newEvent'));
    }
    case 'calendar': return data.create ? openNameField(anchor) : void (data.id && calendarMenu(anchor, data.id));
    case 'calendarPick':
      if (!occ) return;
      return menu(anchor, getState().calendars.filter((c) => !c.readOnly).map((c) => ({
        id: c.id, label: c.name, checked: occ.event.calendarId === c.id, onSelect: () => void updateOccurrence(occ.key, { calendarId: c.id }, revision),
      })));
    case 'busy':
      if (!occ) return;
      return menu(anchor, [
        { id: 'busy', label: t('busy'), checked: occ.event.transparency !== 'transparent', onSelect: () => void updateOccurrence(occ.key, { transparency: 'opaque' }, revision) },
        { id: 'free', label: t('free'), checked: occ.event.transparency === 'transparent', onSelect: () => void updateOccurrence(occ.key, { transparency: 'transparent' }, revision) },
      ]);
    case 'visibility': {
      if (!occ) return; const v = occ.event.visibility ?? 'default';
      return menu(anchor, (['default', 'public', 'private'] as const).map((k) => ({
        id: k, label: k === 'default' ? t('defaultVisibility') : k === 'public' ? t('publicV') : t('privateV'), checked: v === k,
        onSelect: () => void updateOccurrence(occ.key, { visibility: k }, revision),
      })));
    }
    case 'reminder':
      if (!occ) return;
      return menu(anchor, REMINDER_OPTS.map((r) => ({
        id: String(r), label: reminderLabel(r), onSelect: () => {
          const cur = occ.event.reminders ?? [];
          if (!cur.some((x) => x.minutes === r)) void updateOccurrence(occ.key, { reminders: [...cur, { minutes: r, method: 'notification' as const }].sort((a, b) => a.minutes - b.minutes) }, revision);
        },
      })), t('reminders'));
    case 'repeat': return void (data.key && repeatMenu(anchor, data.key));
    case 'evColor': {
      if (!occ) return; const current = occ.event.color?.toUpperCase();
      openCalendarFloat({ anchor, placement: 'bottom-start', render: (close) => <div className="cal-menu">
        <Colors current={current} onPick={(hex) => { close(); void updateOccurrence(occ.key, { color: hex }, revision); }} />
        <MenuList label={t('eventColor')} onDone={close} items={[{ id: 'calendar', label: t('calendarColor'), checked: !occ.event.color, onSelect: () => void updateOccurrence(occ.key, { color: undefined }, revision) }]} />
      </div> });
      return;
    }
    case 'time': return void (data.key && timeMenu(anchor, data.key, data.edge === 'end'));
    case 'tz': return void (data.key && tzMenu(anchor, data.key));
  }
}

function menu(anchor: FloatAnchor, items: MenuEntry[], label?: string) {
  openCalendarFloat({ anchor, placement: 'bottom-start', render: (close) => <MenuList items={items} label={label} onDone={close} /> });
}

/** The event colours as a grid of swatches; the current one carries a check. */
function Colors({ current, onPick }: { current?: string; onPick: (hex: string) => void }) {
  const dark = isDark();
  return <div className="cal-colors" role="group" aria-label={t('eventColor')}>
    {PALETTE.map((c) => <button key={c.id} type="button" title={c.name} aria-label={c.name} aria-pressed={current === c.hex}
      style={{ background: colorFamily(c.hex, dark).backgroundPrimary }} onClick={() => onPick(c.hex)}>{current === c.hex ? <Check aria-hidden /> : null}</button>)}
  </div>;
}

function viewMenu(anchor: FloatAnchor) {
  const p = getState().prefs;
  const cur = p.gridView === 'month' ? 'm' : p.daysPerPeriod === 1 ? 'd' : p.daysPerPeriod === 7 ? 'w' : 'n';
  const days = () => menu(anchor, [2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    id: `days-${n}`, label: t('nDays', { n }), hint: String(n), checked: p.gridView === 'default' && p.daysPerPeriod === n, onSelect: () => setView('default', n),
  })), t('days'));
  const settings = () => menu(anchor, [
    { id: 'weekends', label: t('showWeekends'), checked: p.showWeekends, onSelect: () => void setPrefs({ showWeekends: !p.showWeekends }) },
    { id: 'declined', label: t('showDeclined'), checked: p.showDeclined, onSelect: () => void setPrefs({ showDeclined: !p.showDeclined }) },
    { id: 'weeknumbers', label: t('showWeekNumbers'), checked: p.showWeekNumbers, onSelect: () => void setPrefs({ showWeekNumbers: !p.showWeekNumbers }) },
  ], t('viewSettings'));
  menu(anchor, [
    { id: 'day', label: t('day'), hint: `1 ${t('or')} D`, checked: cur === 'd', onSelect: () => setView('default', 1) },
    { id: 'week', label: t('week'), hint: `0 ${t('or')} W`, checked: cur === 'w', onSelect: () => setView('default', 7) },
    { id: 'month', label: t('month'), hint: 'M', checked: cur === 'm', onSelect: () => setView('month') },
    { kind: 'separator' },
    { id: 'days', label: `${t('days')}…`, checked: cur === 'n', onSelect: days },
    { id: 'settings', label: `${t('viewSettings')}…`, checked: false, onSelect: settings },
  ], t('viewSettings'));
}

function chipMenu(anchor: FloatAnchor, key: string) {
  const occ = findOccurrence(key); if (!occ) return;
  const ro = !!calendarOf(occ.event.calendarId)?.readOnly;
  const keys = getState().selected.includes(key) ? getState().selected : [key];
  const current = (occ.event.color ?? calendarOf(occ.event.calendarId)?.color)?.toUpperCase();
  const items: MenuEntry[] = [
    { id: 'cut', label: t('cut'), icon: <Scissors />, hint: `${MOD} X`, disabled: ro, onSelect: () => copyOccurrences(keys, true) },
    { id: 'copy', label: t('copy'), icon: <Copy />, hint: `${MOD} C`, onSelect: () => copyOccurrences(keys) },
    { id: 'duplicate', label: t('duplicate'), icon: <CopyPlus />, hint: `${MOD} D`, onSelect: () => duplicateOccurrences(keys) },
    { kind: 'separator' },
    { id: 'delete', label: t('del'), icon: <Trash2 />, hint: t('deleteKey'), danger: true, disabled: ro, onSelect: () => void deleteOccurrences(keys) },
  ];
  openCalendarFloat({ anchor, placement: 'bottom-start', render: (close) => <div className="cal-menu">
    {!ro && <Colors current={current} onPick={(hex) => { close(); void updateOccurrence(key, { color: hex }, { expectedRevision: occ.event.revision }); }} />}
    <MenuList items={items} label={occ.event.title || t('noTitle')} onDone={close} />
  </div> });
}

function calendarMenu(anchor: FloatAnchor, id: string) {
  const c = calendarOf(id); if (!c) return;
  const items: MenuEntry[] = [
    { id: 'visible', label: c.visible ? t('hideCal') : t('showCal'), onSelect: () => void updateCalendar(c.id, { visible: !c.visible }) },
    { id: 'only', label: t('onlyThis'), onSelect: () => void showOnlyCalendar(c.id) },
  ];
  if (!c.readOnly) items.push({ id: 'rename', label: t('rename'), onSelect: () => openNameField(anchor, c.id) });
  if (!c.readOnly && !c.primary) items.push({ id: 'primary', label: '设为默认日历', onSelect: () => void updateCalendar(c.id, { primary: true }) });
  if (c.syncUrl) items.push({ id: 'sync', label: '立即同步', onSelect: () => void syncCalendar(c.id) });
  if (c.syncError) items.push({ kind: 'group', label: `上次同步未完成：${c.syncError}` });
  items.push({ id: 'export', label: t('exportIcs'), onSelect: () => void exportCalendar(c.id) });
  if (!c.primary) items.push({ kind: 'separator' }, {
    id: 'delete', label: t('deleteCalendar'), danger: true,
    onSelect: () => void confirmDialog({ title: `${t('deleteCalendar')}：${c.name}`, confirmLabel: t('del'), danger: true }).then((ok) => { if (ok) void removeCalendar(c.id); }),
  });
  openCalendarFloat({ anchor, placement: 'bottom-start', render: (close) => <div className="cal-menu">
    <Colors current={c.color.toUpperCase()} onPick={(hex) => { close(); void updateCalendar(c.id, { color: hex }); }} />
    <MenuList items={items} label={c.name} onDone={close} />
  </div> });
}

/** Names a new local calendar, or renames one. */
function openNameField(anchor: FloatAnchor, id?: string) {
  openCalendarFloat({ anchor, placement: 'bottom-start', role: 'dialog', label: id ? t('rename') : t('newCalendar'), render: (close) => <NameField id={id} close={close} /> });
}
function NameField({ id, close }: { id?: string; close: () => void }) {
  const [name, setName] = useState(id ? calendarOf(id)?.name || '' : '');
  const save = async () => {
    if (!name.trim()) return;
    const saved = id ? await updateCalendar(id, { name: name.trim() }) : await addCalendar(name.trim(), PALETTE[(getState().calendars.length * 5) % PALETTE.length].hex);
    if (saved) close();
  };
  return <div className="cal-name-field">
    <Input data-autofocus aria-label={id ? t('rename') : t('newCalendar')} placeholder={t('newCalendar')} value={name} onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
  </div>;
}

function repeatMenu(anchor: FloatAnchor, key: string) {
  const occ = findOccurrence(key); if (!occ) return;
  const day = occ.startDay; const wd = weekday(day); const { m: mo, d } = ymd(day);
  const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const opts: [string, string | undefined][] = [
    [t('doesNotRepeat'), undefined], [t('daily'), 'FREQ=DAILY'], [t('weekly', { d: wdShort(wd) }), `FREQ=WEEKLY;BYDAY=${WD[wd]}`],
    [t('weekdays'), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'], [t('monthly', { n: d }), `FREQ=MONTHLY;BYMONTHDAY=${d}`], [t('yearly', { d: `${monthName(mo)} ${d}` }), `FREQ=YEARLY;BYMONTH=${mo};BYMONTHDAY=${d}`],
  ];
  const series = occ.seriesId ? getState().events[occ.seriesId] : occ.event.rrule ? occ.event : undefined;
  const norm = (rule: string | undefined) => (rule ? stringifyRRule(parseRRule(rule)) : undefined);
  const cur = norm(series?.rrule);
  const items: MenuEntry[] = opts.map(([label, rule], i) => ({
    id: `rule-${i}`, label, checked: cur === norm(rule),
    onSelect: () => void updateOccurrence(key, { rrule: rule }, series ? { scope: 'all' } : {}),
  }));
  if (cur && !opts.some(([, rule]) => norm(rule) === cur)) items.push({ id: 'current', label: ruleLabel(parseRRule(cur)), checked: true, onSelect: () => {} });
  items.push({ kind: 'separator' }, { id: 'custom', label: t('custom'), onSelect: () => openRecurrenceDialog(key) });
  menu(anchor, items, t('repeat'));
}

function timeMenu(anchor: FloatAnchor, key: string, isEnd: boolean) {
  const occ = findOccurrence(key); if (!occ) return;
  const p = getState().prefs;
  const tz = isEnd ? (occ.event.endTimeZone || occ.event.timeZone || p.primaryTimeZone) : (occ.event.timeZone || p.primaryTimeZone);
  const day = dayOf(occ.start, tz);
  const slots = [...new Set(Array.from({ length: 96 }, (_, i) => isEnd ? occ.start + (i + 1) * 900000 : fromWall({ ...ymd(day), h: Math.floor(i / 4), mi: i % 4 * 15 }, tz)))]
    .filter((x) => !isEnd || x - occ.start <= 24 * 3600000);
  const cur = isEnd ? occ.end : occ.start;
  const items: MenuEntry[] = slots.map((x) => {
    const mins = Math.round((x - occ.start) / 60000);
    return {
      id: String(x), label: panelTime(x, tz, p.format24HourTime), checked: x === cur,
      hint: isEnd ? (mins < 60 ? `${mins}m` : `${(mins / 60).toFixed(mins % 60 ? 1 : 0)}h`) : undefined,
      onSelect: () => void (isEnd ? updateOccurrence(key, { end: x }) : updateOccurrence(key, { start: x, end: x + (occ.end - occ.start) })),
    };
  });
  openCalendarFloat({ anchor, placement: 'bottom-start', render: (close) => <Scrolled><MenuList items={items} label={isEnd ? '结束时间' : '开始时间'} onDone={close} /></Scrolled> });
}

/** A long list in a scrolling frame, opened with its checked item in the middle. */
function Scrolled({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = ref.current, item = frame?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (frame && item) frame.scrollTop = item.offsetTop - frame.clientHeight / 2 + item.offsetHeight / 2;
  }, []);
  return <div ref={ref} className="cal-scroll-menu">{children}</div>;
}

function tzMenu(anchor: FloatAnchor, key: string) {
  const occ = findOccurrence(key); if (!occ) return;
  const p = getState().prefs;
  const zones = ['UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney'];
  menu(anchor, Array.from(new Set([p.primaryTimeZone, ...zones])).map((z) => ({
    id: z, label: z.replace(/_/g, ' '), checked: (occ.event.timeZone ?? p.primaryTimeZone) === z,
    onSelect: () => {
      const oldZone = occ.event.timeZone || p.primaryTimeZone;
      const separateEnd = occ.event.endTimeZone && occ.event.endTimeZone !== oldZone;
      const patch = occ.allDay ? { timeZone: z } : { timeZone: z, endTimeZone: separateEnd ? occ.event.endTimeZone : z, start: fromWall(toWall(occ.start, oldZone), z), end: separateEnd ? occ.end : fromWall(toWall(occ.end, oldZone), z) };
      void updateOccurrence(key, patch, { expectedRevision: occ.event.revision });
    },
  })), t('timeZone'));
}
