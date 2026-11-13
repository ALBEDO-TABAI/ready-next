import { isMac } from '../platform';
import { appShortcut, shortcutKeycaps } from '../../../../../shared/app-shortcuts';
import { occurrenceRef } from '../../../../../shared/calendar-linkage'
import { attachEvent } from '../../linkage/attachments'
import { writeEventTransfer } from '../../linkage/transfer'
import { openWebpageInBrowser } from '../../../browser/openWebpageInBrowser'
import { EventLinks } from './EventLinks';
import { findCalendarOccurrence } from '@shared/calendar/commands';
import { searchCalendar } from '@shared/calendar/search';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, PanelRight, Clock, ArrowRight, Users, Video, MapPin, Link2, Bell, MoreHorizontal, Globe, Palette, Repeat, X } from 'lucide-react';
import { CalEvent, Occurrence, colorFamily, PALETTE, parseIsoDate, isoDate, toWall, fromWall, ymd, dayOf, parseRRule, Attendee, DEFAULT_CALENDAR_COLOR } from '@shared/calendar';
import { useStore, getState, setState, setPrefs, findOccurrence, updateOccurrence, calendarOf, isDark, select, goToDay, toast } from '../store';
import { longDate, panelTime, durationLabel, gmtLabel, ruleLabel, reminderLabel } from '../fmt';
import { Button, IconButton } from '../../../../components/ui/Button';
import { Input, Textarea } from '../../../../components/ui/Field';
import { Switch } from '../../../../components/ui/Toggle';
import { Kbd } from '../../../../components/ui/Display';
import { openCalendarMenu, type MenuData, type MenuKind } from './Menus';
import { openGoto } from './Overlays';
import { t } from '../i18n';
import { MOD } from '../commands';
import { ShortcutList } from './Shortcuts';
import { stopAvailability, removeSlot, fillFree, copyAvailability, createHolds, clearSlots } from '../availability';
import { OPEN_QUICK_SWITCHER_EVENT, requestShellAction } from '../../../workbench/commands/shell-actions';

/** A key combination as shared key caps. */
export function Keys({ keys }: { keys: string[] }) { return <span className="kbds">{keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>; }

export function Panel() {
  const s = useStore((x) => ({ editing: x.editing, overlay: x.overlay, q: x.searchQuery, n: x.selected.length, avail: x.avail.active }));
  const inp = useRef<HTMLInputElement>(null);
  const searching = s.overlay === 'search' || s.overlay === 'shortcuts';
  useEffect(() => { if (searching) inp.current?.focus(); }, [searching]);
  return (
    <aside className="panel" data-testid="panel">
      <div className="panel-head">
        <div className={`search${searching ? ' active' : ''}`}>
          <Search aria-hidden />
          <Input ref={inp} data-testid="search" aria-label={s.overlay === 'shortcuts' ? t('searchShortcuts') : t('search')} placeholder={s.overlay === 'shortcuts' ? t('searchShortcuts') : t('search')} value={s.q}
            onFocus={() => { if (!searching) setState({ overlay: 'search' }); }}
            onChange={(e) => setState({ searchQuery: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape') { setState({ overlay: null, searchQuery: '' }); inp.current?.blur(); } e.stopPropagation(); }} />
          {searching && s.q && <IconButton size="sm" className="search-clear" icon={<X />} title={t('close')} onClick={() => setState({ overlay: null, searchQuery: '' })} />}
        </div>
        {s.overlay !== 'shortcuts' && <IconButton icon={<PanelRight />} title={t('sPanel')} onClick={() => setPrefs({ contextPanel: false })} />}
      </div>
      <div className="panel-body">
        {s.overlay === 'shortcuts' ? <ShortcutList filter={s.q} /> : s.overlay === 'search' ? <SearchResults q={s.q} /> : s.avail ? <AvailabilityPanel /> : s.editing ? <EventPanel key={s.editing} occKey={s.editing} /> : <Useful />}
      </div>
    </aside>
  );
}

function AvailabilityPanel() {
  const a = useStore((x) => x.avail); const z = getState().prefs.primaryTimeZone; const h24 = getState().prefs.format24HourTime;
  return (
    <div className="ps avail" data-testid="availpanel">
      <div className="ps-title"><span className="ps-title-text">{t('shareAvail')}</span><Button size="sm" variant="ghost" onClick={stopAvailability}>{t('exitAvail')}</Button></div>
      <p className="ps-note">{t('availHint')}</p>
      {a.slots.length ? <ul className="av-list">{a.slots.map((x, i) => <li key={i}><span className="tnum">{longDate(dayOf(x.start, z))} · {panelTime(x.start, z, h24)} – {panelTime(x.end, z, h24)}</span><IconButton size="sm" icon={<X />} title={t('del')} onClick={() => removeSlot(i)} /></li>)}</ul>
        : <p className="ps-note">{t('noSlots')}</p>}
      <div className="av-actions">
        <Button size="sm" data-testid="av-fill" onClick={fillFree}>{t('fillFree')}</Button>
        <Button size="sm" variant="primary" data-testid="av-copy" disabled={!a.slots.length} onClick={() => { void copyAvailability(); }}>{t('copyText')}</Button>
        <Button size="sm" data-testid="av-holds" disabled={!a.slots.length} onClick={() => createHolds()}>{t('createHolds')}</Button>
        <Button size="sm" variant="ghost" disabled={!a.slots.length} onClick={clearSlots}>{t('clearAll')}</Button>
      </div>
    </div>
  );
}

// Each row does what its shortcut does (W4 §4: no help item that looks clickable and does nothing).
function Useful() {
  const rows: [string, string[], () => void][] = [
    [t('commandMenu'), [MOD, 'K'], () => window.dispatchEvent(new CustomEvent(OPEN_QUICK_SWITCHER_EVENT))],
    [t('toggleSidebar'), ['\\'], () => requestShellAction('toggle-sidebar')],
    [t('goToDate'), ['.'], () => openGoto()],
    [t('sPanel'), shortcutKeycaps(appShortcut('calendar.panel'), isMac), () => setPrefs({ contextPanel: !getState().prefs.contextPanel })],
    [t('allShortcuts'), ['?'], () => setState({ overlay: 'shortcuts' })],
  ];
  return (
    <div className="ps">
      <div className="ps-title">{t('usefulShortcuts')}</div>
      <ul className="ps-list">{rows.map(([l, k, run]) => <li key={l} role="button" tabIndex={0} onClick={run} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(); } }}><span>{l}</span><Keys keys={k} /></li>)}</ul>
    </div>
  );
}

function SearchResults({ q }: { q: string }) {
  const s = useStore((x) => ({ events: x.events, today: x.today }));
  const res = useMemo(() => {
    const qq = q.trim().toLowerCase(); if (!qq) return [] as Occurrence[];
    return searchCalendar(Object.values(s.events),qq,s.today,getState().prefs.primaryTimeZone);
  }, [q, s.events, s.today]);
  if (!q.trim()) return null;
  if (!res.length) return <div className="ps"><p className="ps-note">{t('noResults')}</p></div>;
  const up = res.filter((o) => o.end >= Date.now()), past = res.filter((o) => o.end < Date.now()).reverse();
  const tz = getState().prefs.primaryTimeZone, h24 = getState().prefs.format24HourTime;
  const row = (o: Occurrence) => (
    <div key={o.key} className="side-row result-row" onClick={() => { goToDay(o.startDay); select([o.key]); setState({ overlay: null }); }}>
      <span className="swatch" style={{ ['--sw' as any]: colorFamily(calendarOf(o.event.calendarId)?.color || DEFAULT_CALENDAR_COLOR, isDark()).backgroundPrimary }} />
      <span className="lbl"><span className="result-title">{o.event.title || t('noTitle')}</span><span className="result-when">{longDate(o.startDay)}{o.allDay ? '' : ` · ${panelTime(o.start, tz, h24)}`}</span></span>
    </div>
  );
  return <div className="ps">{up.length > 0 && <><div className="ps-sec">{t('upcoming')}</div>{up.map(row)}</>}{past.length > 0 && <><div className="ps-sec">{t('past')}</div>{past.map(row)}</>}</div>;
}


function EventPanel({ occKey }: { occKey: string }) {
  const s = useStore((x) => ({ events: x.events, focus: x.focusTitle, prefs: x.prefs, calendars: x.calendars, dark: isDark(x) }));
  const visibleOcc=findOccurrence(occKey);const occ=visibleOcc?findCalendarOccurrence(Object.values(s.events),occKey,visibleOcc.event.timeZone||s.prefs.primaryTimeZone):undefined; const titleRef = useRef<HTMLDivElement>(null);
  const [video,setVideo]=useState(occ?.event.conferenceUrl||'');const [link,setLink]=useState(occ?.event.url||'');
  const [desc, setDesc] = useState(occ?.event.description ?? ''); const [loc, setLoc] = useState(occ?.event.location ?? ''); const [guest, setGuest] = useState(''); const [optsOpen, setOptsOpen] = useState(false);
  const editRevision=useRef(occ?.event.revision||1);
  useLayoutEffect(()=>{const el=titleRef.current;if(el&&document.activeElement!==el)el.textContent=occ?.event.title||''},[occ?.event.title]);
  useEffect(()=>{const field=(document.activeElement as HTMLElement|null)?.dataset.field;if(field!=='l')setLoc(occ?.event.location||'');if(field!=='n')setDesc(occ?.event.description||'');if(field!=='v')setVideo(occ?.event.conferenceUrl||'');if(field!=='u')setLink(occ?.event.url||'')},[occ?.event.location,occ?.event.description,occ?.event.conferenceUrl,occ?.event.url]);
  const firstFocus = useRef(s.focus); useEffect(() => { const el = titleRef.current; if (s.focus === firstFocus.current && getState().draftId !== occKey && occ?.event.title) return; if (el && occ) { el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const sl = getSelection(); sl?.removeAllRanges(); sl?.addRange(r); } }, [s.focus]); // eslint-disable-line
  if (!occ) return <Useful />;
  const ev = occ.event; const cal = calendarOf(ev.calendarId); const ro = !!cal?.readOnly; const tz = ev.timeZone||s.prefs.primaryTimeZone; const h24 = s.prefs.format24HourTime;
  const fam = colorFamily(ev.color || cal?.color || DEFAULT_CALENDAR_COLOR, s.dark);
  const patch = async(p: Partial<CalEvent>) => {const result=await updateOccurrence(occKey,p,{expectedRevision:editRevision.current});if(result)editRevision.current=getState().events[occ.seriesId||ev.id]?.revision||editRevision.current;return result};
  const saveTitle = () => { const v = titleRef.current?.textContent ?? ''; if (v !== ev.title) patch({ title: v }); };
  const dur = Math.round((occ.end - occ.start) / 60000);
  const anchor = (e: React.MouseEvent) => (e.currentTarget as HTMLElement).getBoundingClientRect();
  const series = occ.seriesId ? getState().events[occ.seriesId] : ev.rrule ? ev : undefined;
  const ruleText = series?.rrule ? ruleLabel(parseRRule(series.rrule)) : t('doesNotRepeat');
  const toggleAllDay = () => {
    if (ev.allDay) { const { y, m, d } = ymd(occ.startDay); const st = fromWall({ y, m, d, h: 9 }, tz); patch({ allDay: false, start: st, end: st + s.prefs.defaultEventDuration * 60000, timeZone: tz }); }
    else patch({ allDay: true, start: isoDate(occ.startDay), end: isoDate(occ.endDay + 1), timeZone: undefined });
  };
  const addGuest = () => {
    const em = guest.trim(); if (!/^\S+@\S+$/.test(em)) return; setGuest('');
    const list: Attendee[] = [...(ev.attendees ?? [])]; const pr = getState().prefs; if (pr.email && !list.some((a) => a.organizer)) list.unshift({ email: pr.email, name: pr.displayName || undefined, rsvp: 'accepted', organizer: true, self: true });
    if (!list.some((a) => a.email === em)) list.push({ email: em, rsvp: 'needsAction' });
    const addVideo = pr.autoAddVideo && pr.videoProvider !== 'none' && pr.videoUrl && !ev.conferenceUrl;
    patch(addVideo ? { attendees: list, conferenceUrl: pr.videoUrl } : { attendees: list });
  };
  const showOpts = optsOpen || ev.allDay || !!series || (!!ev.timeZone && ev.timeZone !== tz);
  const menuAt = (kind: MenuKind, data: MenuData = {}) => (e: React.MouseEvent) => openCalendarMenu(kind, anchor(e), { key: occKey, ...data });
  const evTz = ev.timeZone || tz;
  return (
    <div className="ev" data-testid="eventpanel" onFocusCapture={()=>{editRevision.current=ev.revision||1}}>
      <div className="ev-top"><span className="ev-kind">{t('event')}</span>
        <IconButton className="ev-more" icon={<MoreHorizontal />} title={t('event')} aria-haspopup="menu" onClick={(e) => openCalendarMenu('chip', anchor(e), { key: occKey })} /></div>
      <div className="ev-sec first"><div className="ev-r">
        <div ref={titleRef} className="ev-title" data-testid="ev-title" contentEditable={!ro} suppressContentEditableWarning data-ph={t('noTitle')}
          onBlur={saveTitle} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); setState({ draftId: null }); } if (e.key === 'Escape') { (e.target as HTMLElement).textContent = ev.title; (e.target as HTMLElement).blur(); } e.stopPropagation(); }} /></div></div>
      <div className="ev-sec">
        {ev.allDay ? <div className="ev-r"><div className="ev-f"><Clock size={16} /><DateField occ={occ} disabled={ro} label={`${longDate(occ.startDay)}${occ.endDay > occ.startDay ? ` → ${longDate(occ.endDay)}` : ''}`} onChange={(d) => { const len = occ.endDay - occ.startDay; patch({ start: isoDate(d), end: isoDate(d + len + 1) }); }} /></div></div> : <>
          <div className="ev-r">
            <button className="ev-f ev-t1 tnum" data-testid="ev-start" data-field="s" disabled={ro} onClick={menuAt('time', { edge: 'start' })}><Clock size={16} /><span>{panelTime(occ.start, tz, h24)}</span></button>
            <button className="ev-f ev-t2 tnum" data-testid="ev-end" data-field="e" disabled={ro} onClick={menuAt('time', { edge: 'end' })}><ArrowRight size={16} /><span>{panelTime(occ.end, ev.endTimeZone||tz, h24)}</span><span className="dur">{durationLabel(dur, t)}</span></button>
          </div>
          <div className="ev-r ind"><DateField occ={occ} disabled={ro} onChange={(d) => { const delta=d-occ.startDay,endZone=ev.endTimeZone||tz;patch({start:fromWall({...toWall(occ.start,tz),...ymd(d)},tz),end:fromWall({...toWall(occ.end,endZone),...ymd(dayOf(occ.end,endZone)+delta)},endZone)}); }} /></div></>}
        {!showOpts ? <div className="ev-r ind"><button className="ev-f ev-opts" data-testid="ev-opts" data-field="x" disabled={ro} onClick={() => setOptsOpen(true)}><span>{t('allDay')}</span><span>{t('timeZone')}</span><span>{t('repeat')}</span></button></div> : <>
          <div className="ev-r"><span className="ev-f ev-switch" data-testid="ev-allday" data-field="a" onClick={(e) => { if (!ro && !(e.target as HTMLElement).closest('[role=switch]')) toggleAllDay(); }}><Switch checked={!!ev.allDay} disabled={ro} label={t('allDay')} onChange={toggleAllDay} /><span className={ev.allDay ? '' : 'dim'}>{t('allDay')}</span></span></div>
          {!ev.allDay && <div className="ev-r"><button className="ev-f" data-testid="ev-tz" data-field="z" disabled={ro} onClick={menuAt('tz')}><Globe size={16} /><span className="dim">{gmtLabel(evTz)}</span><span>&nbsp;{evTz.split('/').pop()!.replace(/_/g, ' ')}</span></button></div>}
          <div className="ev-r"><button className="ev-f" data-testid="ev-repeat" data-field="r" disabled={ro} onClick={menuAt('repeat')}><Repeat size={16} /><span className={series ? '' : 'dim'}>{series ? ruleText : t('repeat')}</span></button></div></>}
      </div>
      {(showOpts||occ.isMultiDay)&&<div className="ev-sec"><div className="ev-r ind"><label className="ev-f ev-end-date"><span className="dim">结束日期</span><Input className="cal-inline" data-testid="ev-end-date" type="date" disabled={ro} value={isoDate(ev.allDay?occ.endDay:dayOf(occ.end-1,ev.endTimeZone||tz))} onChange={e=>{if(!e.target.value)return;const day=parseIsoDate(e.target.value);void patch({end:ev.allDay?isoDate(day+1):fromWall({...toWall(occ.end,ev.endTimeZone||tz),...ymd(day)},ev.endTimeZone||tz)})}}/></label></div></div>}
      <div className="ev-sec">
        <div className="ev-r"><div className="ev-f"><Users size={16} /><Input className="cal-inline" data-field="p" aria-label={t('addParticipants')} placeholder={t('addParticipants')} value={guest} disabled={ro} onChange={(e) => setGuest(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addGuest(); e.stopPropagation(); }} /></div></div>
        {ev.attendees?.map((a) => (
          <div key={a.email} className="ev-r ind"><div className="ev-f"><span className="att">{a.name || a.email}{a.organizer ? <span className="dim"> · {t('organizer')}</span> : null}</span>
            {!a.organizer && !ro && <IconButton size="sm" icon={<X />} title={t('del')} onClick={() => patch({ attendees: ev.attendees!.filter((x) => x.email !== a.email) })} />}</div></div>
        ))}
        <div className="ev-r"><div className="ev-f"><Video size={16} /><Input className="cal-inline" data-field="v" aria-label={t('conferencing')} placeholder={t('conferencing')} value={video} onChange={e=>setVideo(e.target.value)} disabled={ro} onBlur={(e) => { if (e.target.value !== (ev.conferenceUrl ?? '')) patch({ conferenceUrl: e.target.value || undefined }); }} onKeyDown={(e) => e.stopPropagation()} /></div></div>
        <div className="ev-r"><button className="ev-f" data-testid="ev-color" data-field="o" disabled={ro} onClick={menuAt('evColor')}><Palette size={16} /><span className={ev.color ? '' : 'dim'}>{ev.color ? (PALETTE.find((c) => c.hex === ev.color?.toUpperCase())?.name ?? ev.color) : t('eventColor')}</span>{ev.color && <span className="ev-sw" style={{ ['--sw' as any]: fam.backgroundPrimary }} />}</button></div>
        <div className="ev-r"><div className="ev-f"><MapPin size={16} /><Input className="cal-inline" data-field="l" aria-label={t('location')} placeholder={t('location')} value={loc} disabled={ro} onChange={(e) => setLoc(e.target.value)} onBlur={() => { if (loc !== (ev.location ?? '')) patch({ location: loc || undefined }); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLElement).blur(); e.stopPropagation(); }} /></div></div>
      </div>
      <div className="ev-sec"><div className="ev-r"><div className="ev-f"><Link2 size={16} /><Input className="cal-inline" data-field="u" aria-label={t('addLink')} placeholder={t('addLink')} value={link} onChange={e=>setLink(e.target.value)} disabled={ro} onBlur={(e) => { if (e.target.value !== (ev.url ?? '')) patch({ url: e.target.value || undefined }); }} onKeyDown={(e) => e.stopPropagation()} /></div></div></div>
      <EventLinks occKey={occKey} title={ev.title} readOnly={ro} />
      <div className="ev-sec"><div className="ev-r auto"><div className="ev-f noicon"><Textarea className="cal-inline" data-field="n" aria-label={t('description')} rows={Math.min(12, Math.max(1, desc.split('\n').length))} placeholder={t('description')} value={desc} disabled={ro} onChange={(e) => setDesc(e.target.value)} onBlur={() => { if (desc !== (ev.description ?? '')) patch({ description: desc || undefined }); }} onKeyDown={(e) => e.stopPropagation()} /></div></div></div>
      <div className="ev-sec">
        <div className="ev-r"><button className="ev-f" data-field="c" disabled={ro} onClick={menuAt('calendarPick')}><span className="ev-sw" style={{ ['--sw' as any]: fam.backgroundPrimary }} /><span>{cal?.name}</span></button></div>
        <div className="ev-r ind ev-pair">
          <button className="ev-f" data-field="f" disabled={ro} onClick={menuAt('busy')}>{ev.transparency === 'transparent' ? t('free') : t('busy')}</button>
          <button className="ev-f" data-field="y" disabled={ro} onClick={menuAt('visibility')}>{ev.visibility === 'private' ? t('privateV') : ev.visibility === 'public' ? t('publicV') : t('defaultVisibility')}</button>
        </div>
        <div className="ev-r"><button className="ev-f" data-field="m" disabled={ro} onClick={menuAt('reminder')}><Bell size={16} /><span className="dim">{t('reminders')}</span></button></div>
        <div className="ev-r ind"><button className="ev-f" draggable onDragStart={e => writeEventTransfer(e.dataTransfer, occurrenceRef(occ), ev.title, occ.allDay)} title="拖到文档或画板">拖出日程</button><button className="ev-f" onClick={() => void attachEvent(occurrenceRef(occ), ev.title, occ.allDay).catch(e => toast(String(e)))}>加入对话</button></div>
        {[...new Set(`${ev.description || ''} ${ev.location || ''}`.match(/https?:\/\/[^\s<>"）)]+/g) || [])].map(url => <div className="ev-r ind" key={url}><button className="ev-f" onClick={() => void openWebpageInBrowser(url).catch(e => toast(String(e)))}>{url}</button></div>)}
        {ev.location && <div className="ev-r ind"><button className="ev-f" onClick={()=>{const query=encodeURIComponent(ev.location!);const url=s.prefs.mapsProvider==='apple'?`https://maps.apple.com/?q=${query}`:s.prefs.mapsProvider==='osm'?`https://www.openstreetmap.org/search?query=${query}`:`https://www.google.com/maps/search/?api=1&query=${query}`;void openWebpageInBrowser(url).catch(e=>toast(String(e)));}}>在地图中查看</button></div>}
        {ev.conferenceUrl && <div className="ev-r ind"><button className="ev-f" onClick={()=>void openWebpageInBrowser(ev.conferenceUrl!).catch(e=>toast(String(e)))}>加入会议</button></div>}
        {ev.url && <div className="ev-r ind"><button className="ev-f" onClick={()=>void openWebpageInBrowser(ev.url!).catch(e=>toast(String(e)))}>打开相关链接</button></div>}
        {(ev.reminders ?? []).map((r, i) => (
          <div key={i} className="ev-r ind"><div className="ev-f ev-grow"><span className="ev-grow">{reminderLabel(r.minutes)}{r.method==='email'?' · 邮件（仅保留记录）':''}</span>
            {!ro && <IconButton size="sm" icon={<X />} title={t('del')} onClick={() => patch({ reminders: ev.reminders!.filter((_, j) => j !== i) })} />}</div></div>
        ))}
        {!ro && !(ev.reminders ?? []).length && <div className="ev-r ind"><button className="ev-f dim" onClick={menuAt('reminder')}>{t('addReminder')}</button></div>}
      </div>
    </div>
  );
}

function DateField({ occ, disabled, onChange, label }: { occ: Occurrence; disabled?: boolean; label?: string; onChange: (d: number) => void }) {
  return (
    <label data-field="d" className="ev-f ev-date">
      {label ?? longDate(occ.startDay)}
      {/* The native date picker sits invisibly over the label: the label reads like the other fields. */}
      <input type="date" className="ev-date-input" aria-label={longDate(occ.startDay)} disabled={disabled} value={isoDate(occ.startDay)} onChange={(e) => { if (e.target.value) onChange(parseIsoDate(e.target.value)); }}
        onKeyDown={(e) => e.stopPropagation()} />
    </label>
  );
}
void toWall; void dayOf;
