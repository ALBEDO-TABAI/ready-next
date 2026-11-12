import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, PanelRight } from 'lucide-react';
import { ymd } from '@shared/calendar';
import { useStore, goToday, step, openMenu, setPrefs, periodDays, getState } from '../store';
import { monthName } from '../fmt';
import { t } from '../i18n';
import { NavigationBackEntry } from '../../../workbench/NavigationBackEntry';

export function TopBar() {
  const s = useStore((x) => ({ view: x.prefs.gridView, days: x.prefs.daysPerPeriod, anchor: x.anchor, panel: x.prefs.contextPanel, locale: x.prefs.locale }));
  const label = s.view === 'month' ? t('month') : s.days === 1 ? t('day') : s.days === 7 ? t('week') : t('nDays', { n: s.days });
  const ds = periodDays(getState()); const ref = s.view === 'month' ? s.anchor : ds[Math.floor(ds.length / 2)] ?? s.anchor;
  const { y, m } = ymd(ref);
  const Prev = s.view === 'month' ? ChevronUp : ChevronLeft, Next = s.view === 'month' ? ChevronDown : ChevronRight;
  return (
    <div className="topbar" data-testid="topbar">
      <div className="topbar-row">
        <NavigationBackEntry mode="calendar" />
        <div className="topbar-spacer" />
        <button className="btn" data-testid="viewbtn" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu({ kind: 'view', x: r.left, y: r.bottom + 8 }); }}>
          <span>{label}</span><ChevronDown size={14} />
        </button>
        <button className="btn" onClick={() => goToday()}>{t('today')}</button>
        <button className="ibtn" style={{ marginLeft: 6 }} onClick={() => step(-1)}><Prev size={18} /></button>
        <button className="ibtn" style={{ marginLeft: -5 }} onClick={() => step(1)}><Next size={18} /></button>
        {!s.panel && <button className="ibtn" onClick={() => setPrefs({ contextPanel: true })}><PanelRight size={18} /></button>}
      </div>
      <div className="topbar-title" data-testid="title">{monthName(m)} <span className="yr tnum">{y}</span></div>
    </div>
  );
}
