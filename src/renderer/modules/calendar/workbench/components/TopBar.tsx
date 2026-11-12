import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, PanelRight } from 'lucide-react';
import { ymd } from '@shared/calendar';
import { useStore, goToday, step, setPrefs, periodDays, getState } from '../store';
import { Button, IconButton } from '../../../../components/ui/Button';
import { openCalendarMenu } from './Menus';
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
        <Button size="sm" data-testid="viewbtn" aria-haspopup="menu" onClick={(e) => openCalendarMenu('view', e.currentTarget.getBoundingClientRect())}>
          <span>{label}</span><ChevronDown aria-hidden />
        </Button>
        <Button size="sm" onClick={() => goToday()}>{t('today')}</Button>
        <IconButton icon={<Prev />} title={t('prevPeriod')} onClick={() => step(-1)} />
        <IconButton icon={<Next />} title={t('nextPeriod')} onClick={() => step(1)} />
        {!s.panel && <IconButton icon={<PanelRight />} title={t('sPanel')} onClick={() => setPrefs({ contextPanel: true })} />}
      </div>
      <div className="topbar-title" data-testid="title">{monthName(m)} <span className="yr tnum">{y}</span></div>
    </div>
  );
}
