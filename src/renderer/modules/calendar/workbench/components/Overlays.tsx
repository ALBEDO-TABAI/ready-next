// The calendar's two floats with their own content: the go-to-date box and the custom recurrence dialog. Both open
// in the app's float layer (W1 §5); toasts and the edit-scope question use the shared toast and dialog.
import { useState } from 'react';
import { getState, goToDay, findOccurrence, updateOccurrence } from '../store';
import { parseRRule, stringifyRRule, weekday, ymd, isoDate, parseIsoDate, RRule } from '@shared/calendar';
import { Button } from '../../../../components/ui/Button';
import { Input, Select } from '../../../../components/ui/Field';
import { Segmented } from '../../../../components/ui/Toggle';
import { closeFloat, isFloatOpen } from '../../../../components/ui/float/float-store';
import { t } from '../i18n';
import { parseDateInput } from '../dateinput';
import { longDate, wdShort, ruleLabel } from '../fmt';
import { openCalendarFloat } from '../floats';

const GOTO = 'calendar-goto';
const CENTER = { left: 0, top: 0, right: 0, bottom: 0 };

/** “.” or 前往日期: a date typed in any of the forms dateinput.ts reads. */
export function openGoto() {
  if (isFloatOpen(GOTO)) return;
  openCalendarFloat({ id: GOTO, anchor: CENTER, placement: 'center', role: 'dialog', label: t('goToDate'), className: 'cal-goto', render: (close) => <GotoBox close={close} /> });
}
export const isGotoOpen = () => isFloatOpen(GOTO);
export const closeGoto = () => closeFloat(GOTO);

function GotoBox({ close }: { close: () => void }) {
  const [q, setQ] = useState(''); const d = parseDateInput(q, getState().today);
  return <div data-testid="goto">
    <Input data-autofocus aria-label={t('goToDate')} placeholder={t('enterDate')} value={q} onChange={(e) => setQ(e.target.value)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && d !== null) { e.preventDefault(); goToDay(d); close(); } }} />
    {d !== null && <div className="cal-goto-hit" role="status">{longDate(d)}</div>}
  </div>;
}

/** Custom recurrence: frequency and interval, weekdays (weekly), day of month or nth weekday (monthly), the end. */
export function openRecurrenceDialog(occKey: string) {
  openCalendarFloat({ anchor: CENTER, placement: 'center', modal: true, role: 'dialog', label: t('customRepeat'), className: 'rn-dialog cal-rec', render: (close) => <RecurrenceForm occKey={occKey} close={close} /> });
}

function RecurrenceForm({ occKey, close }: { occKey: string; close: () => void }) {
  const occ = findOccurrence(occKey);
  const series = occ ? (occ.seriesId ? getState().events[occ.seriesId] : occ.event) : undefined;
  const init: RRule = series?.rrule ? parseRRule(series.rrule) : { freq: 'WEEKLY', interval: 1, wkst: 1, byDay: occ ? [{ wd: weekday(occ.startDay) }] : [] };
  const day = occ?.startDay ?? getState().today; const wd = weekday(day); const { d } = ymd(day); const nth = Math.ceil(d / 7);
  const [freq, setFreq] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'>(init.freq === 'DAILY' || init.freq === 'WEEKLY' || init.freq === 'MONTHLY' || init.freq === 'YEARLY' ? init.freq : 'WEEKLY');
  const [interval, setInterval] = useState(init.interval || 1);
  const [days, setDays] = useState<number[]>(init.byDay?.filter((b) => !b.n).map((b) => b.wd) ?? [wd]);
  const [mMode, setMMode] = useState<'day' | 'nth'>(init.byDay?.some((b) => b.n) ? 'nth' : 'day');
  const [end, setEnd] = useState<'never' | 'until' | 'count'>(init.count ? 'count' : init.until !== undefined ? 'until' : 'never');
  const [count, setCount] = useState(init.count ?? 10);
  const [until, setUntil] = useState(isoDate(init.until !== undefined && init.untilIsDate ? init.until : day + 90));
  if (!occ) return <p>{t('noResults')}</p>;
  const build = (): RRule => {
    const r: RRule = { freq, interval: Math.max(1, interval), wkst: 1 };
    if (freq === 'WEEKLY') r.byDay = (days.length ? days : [wd]).slice().sort().map((x) => ({ wd: x }));
    if (freq === 'MONTHLY') { if (mMode === 'day') r.byMonthDay = [d]; else r.byDay = [{ wd, n: nth > 4 ? -1 : nth }]; }
    if (end === 'count') r.count = Math.max(1, count);
    if (end === 'until') { r.until = parseIsoDate(until); r.untilIsDate = true; }
    return r;
  };
  const save = () => { void updateOccurrence(occKey, { rrule: stringifyRRule(build()) }, { scope: series?.rrule ? 'all' : undefined }); close(); };
  const units: Record<string, string> = { DAILY: interval > 1 ? t('uDays') : t('uDay'), WEEKLY: interval > 1 ? t('uWeeks') : t('uWeek'), MONTHLY: interval > 1 ? t('uMonths') : t('uMonth'), YEARLY: interval > 1 ? t('uYears') : t('uYear') };
  const ord = t('ordN').split('|');
  return <div data-testid="recurrence" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }}>
    <h2 className="rn-dialog__title">{t('customRepeat')}</h2>
    <div className="cal-rec-row"><span className="cal-rec-label">{t('every')}</span>
      <Input data-testid="rec-interval" type="number" min={1} max={99} value={interval} className="cal-rec-number" aria-label={t('every')}
        onChange={(e) => setInterval(Math.max(1, Math.min(99, +e.target.value || 1)))} />
      <Select data-testid="rec-freq" aria-label={t('repeat')} value={freq} onChange={(e) => setFreq(e.target.value as typeof freq)}
        options={(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).map((f) => ({ value: f, label: units[f] }))} /></div>
    {freq === 'WEEKLY' && <div className="cal-rec-row"><span className="cal-rec-label">{t('repeatOn')}</span><div className="cal-rec-days" role="group" aria-label={t('repeatOn')}>
      {[0, 1, 2, 3, 4, 5, 6].map((x) => <button key={x} type="button" data-testid={`rec-day-${x}`} aria-pressed={days.includes(x)} aria-label={wdShort(x)}
        onClick={() => setDays((p) => (p.includes(x) ? p.filter((y) => y !== x) : [...p, x]))}>{wdShort(x).replace(/^週|^周/, '')}</button>)}</div></div>}
    {freq === 'MONTHLY' && <div className="cal-rec-row"><span className="cal-rec-label" /><Select data-testid="rec-mmode" aria-label={t('repeat')} value={mMode} onChange={(e) => setMMode(e.target.value as 'day' | 'nth')}
      options={[{ value: 'day', label: t('monthDayN', { n: d }) }, { value: 'nth', label: t('monthNth', { o: ord[nth > 4 ? 4 : nth - 1], d: wdShort(wd) }) }]} /></div>}
    <div className="cal-rec-row top"><span className="cal-rec-label">{t('ends')}</span><div className="cal-rec-ends">
      <Segmented label={t('ends')} value={end} onChange={setEnd} options={[{ value: 'never', label: t('never') }, { value: 'until', label: t('endOnDate') }, { value: 'count', label: t('endAfterCount') }]} />
      {end === 'until' && <Input data-testid="rec-until" type="date" aria-label={t('endOnDate')} value={until} onChange={(e) => setUntil(e.target.value)} />}
      {end === 'count' && <label className="cal-rec-count"><Input data-testid="rec-count" type="number" min={1} max={999} value={count} className="cal-rec-number" aria-label={t('endAfterCount')}
        onChange={(e) => setCount(Math.max(1, +e.target.value || 1))} />{t('occurrencesN')}</label>}
    </div></div>
    <div className="cal-rec-sum" data-testid="rec-summary">{ruleLabel(build())}</div>
    <div className="rn-dialog__actions"><Button variant="ghost" onClick={close}>{t('cancel')}</Button><Button variant="primary" data-testid="rec-done" onClick={save}>{t('done')}</Button></div>
  </div>;
}
