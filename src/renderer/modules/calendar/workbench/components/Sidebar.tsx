import { LayerSwitches } from '../layers/LayerDays';
import { TodoSection } from '../layers/TodoSection';
import { useState } from 'react';
import { ChevronUp, ChevronDown, Search, SquarePen, Eye, EyeOff, MoreHorizontal, Plus, CalendarSearch, HelpCircle } from 'lucide-react';
import { startOfWeek, startOfMonth, addMonths, weekday, ymd, parseIsoDate, DayNum, colorFamily } from '@shared/calendar';
import { useStore, getState, setState, goToDay, updateCalendar, openOverlay, createEvent, importIcsFile, isDark, tz, openCalendarAction } from '../store';
import { openMenu as openFloatMenu } from '../../../../components/ui/float/open-menu';
import { IconButton } from '../../../../components/ui/Button';
import { Input } from '../../../../components/ui/Field';
import { SectionHeader } from '../../../../components/ui/Display';
import { openCalendarMenu } from './Menus';
import { miniTitle, wdMini } from '../fmt';
import { t } from '../i18n';
import { parseDateInput } from '../dateinput';
import { ShellSidebarToggle } from '../../../workbench/shell/ShellSidebar';

export function MiniMonth() {
  const s = useStore((x) => ({ anchor: x.anchor, today: x.today, wso: x.prefs.weekStartsOn, view: x.prefs.gridView, days: x.prefs.daysPerPeriod }));
  const [page, setPage] = useState<DayNum | null>(null);
  const month = page ?? startOfMonth(s.anchor);
  const first = startOfWeek(month, s.wso); const { m } = ymd(month);
  const visFirst = s.view === 'month' ? startOfWeek(startOfMonth(s.anchor), s.wso) : s.days === 7 ? startOfWeek(s.anchor, s.wso) : s.anchor;
  const visLast = s.view === 'month' ? visFirst + 41 : visFirst + s.days - 1;
  const rows = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, i) => first + w * 7 + i));
  return (
    <div className="mini" data-testid="minimonth">
      <div className="mini-head">
        <div className="mini-title" style={{ opacity: page === null ? 0 : 1 }}>{miniTitle(month)}</div>
        <IconButton size="sm" icon={<ChevronUp />} title="上个月" onClick={() => setPage(addMonths(month, -1))} />
        <IconButton size="sm" icon={<ChevronDown />} title="下个月" onClick={() => setPage(addMonths(month, 1))} />
      </div>
      <div className="mini-grid">
        {Array.from({ length: 7 }, (_, i) => <div key={i} className="mini-wd">{wdMini((i + s.wso) % 7)}</div>)}
        {rows.map((r, w) => {
          const cur = r.some((d) => d >= visFirst && d <= visLast) && (s.view === 'month' || s.days >= 7);
          return <div key={w} className={`mini-row${cur ? ' cur' : ''}`}>
            {r.map((d) => {
              const dm = ymd(d).m; const wd = weekday(d);
              const sel = s.view !== 'month' && s.days < 7 && d >= visFirst && d <= visLast;
              return <button key={d} className={`mini-day tnum${dm !== m ? ' out' : ''}${d === s.today ? ' today' : ''}${wd === 0 || wd === 6 ? ' wknd' : ''}${sel ? ' sel' : ''}`}
                onClick={() => { goToDay(d); setPage(null); }}><span>{ymd(d).d}</span></button>;
            })}
          </div>;
        })}
      </div>
    </div>
  );
}

export function Sidebar() {
  const s = useStore((x) => ({ calendars: x.calendars, accounts: x.accounts, dark: isDark(x) }));
  const [q, setQ] = useState('');
  const go = () => { const d = parseDateInput(q, getState().today); if (d !== null) { goToDay(d); setQ(''); } };
  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar-top">
        <span className="sidebar-title">日历</span>
        <IconButton icon={<Search />} title={t('search')} onClick={() => openOverlay('search')} />
        <IconButton className="sidebar-new" icon={<SquarePen />} title={t('newEvent')} onClick={() => openCalendarAction('quick')} />
        <ShellSidebarToggle className="rn-icon-btn" />
      </div>
      <div className="sidebar-scroll panel-hover-scrollbar">
        <MiniMonth />
        <LayerSwitches />
        <TodoSection />
        <div className="side-goto">
          <CalendarSearch aria-hidden />
          <Input aria-label={t('goToDate')} placeholder={t('goToDate')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
        </div>
        <div className="sidebar-sep" />
        {s.accounts.map((a) => (
          <div key={a.id} className="side-sec">
            <SectionHeader title={a.kind === 'local' ? t('local') : a.name} />
            {s.calendars.filter((c) => c.accountId === a.id).map((c) => {
              const fam = colorFamily(c.color, s.dark);
              return (
                <div key={c.id} className={`side-row${c.visible ? '' : ' hidden'}`} data-cal={c.id}
                  onClick={() => updateCalendar(c.id, { visible: !c.visible })}
                  onContextMenu={(e) => { e.preventDefault(); openCalendarMenu('calendar', { x: e.clientX, y: e.clientY }, { id: c.id }); }}>
                  <span className={`swatch${c.visible ? '' : ' off'}`} style={{ ['--sw' as any]: fam.backgroundPrimary }} />
                  <span className="lbl">{c.name}</span>
                  {c.primary && <span className="tag">{t('defaultTag')}</span>}
                  <span className="tools">
                    <IconButton size="sm" icon={c.visible ? <Eye /> : <EyeOff />} title={c.visible ? t('hideCal') : t('showCal')} onClick={(e) => { e.stopPropagation(); updateCalendar(c.id, { visible: !c.visible }); }} />
                    <IconButton size="sm" icon={<MoreHorizontal />} title={c.name} aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); openCalendarMenu('calendar', e.currentTarget.getBoundingClientRect(), { id: c.id }); }} />
                  </span>
                </div>
              );
            })}
            <div className="side-row side-add" role="button" tabIndex={0}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                // 新建日历 (W4 §4): a local calendar, a subscription, or a file — one menu instead of three entries.
                openFloatMenu(r, [
                  { id: 'local', label: t('newLocalCalendar'), onSelect: () => openCalendarMenu('calendar', r, { create: true }) },
                  { id: 'subscribe', label: t('subscribeUrl'), onSelect: () => openCalendarAction('subscribe') },
                  { id: 'import', label: t('importIcs'), onSelect: () => importIcsFile() },
                ], { placement: 'bottom-start', label: t('addCalendar') });
              }}><Plus aria-hidden /><span className="lbl">{t('addCalendar')}</span></div>
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <IconButton icon={<HelpCircle />} title={t('allShortcuts')} onClick={() => openOverlay('shortcuts')} />
      </div>
    </aside>
  );
}

export function newEventNow() {
  const s = getState(); const now = Date.now(); const step = 15 * 60000;
  const start = Math.ceil(now / step) * step; const inView = s.prefs.gridView === 'month' || true;
  void inView; void parseIsoDate; void tz;
  createEvent({ allDay: false, start, end: start + s.prefs.defaultEventDuration * 60000 }, { draft: true });
  setState({ anchor: s.today });
}
