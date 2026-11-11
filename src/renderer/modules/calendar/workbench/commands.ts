import { openReadyRef } from '../../workbench/open-ready-ref';
// Command registry: shared by the keyboard handler, ⌘K menu, shortcuts panel and native menu.
import { getState, setState, setView, goToday, step, zoom, openOverlay, setPrefs, deleteOccurrences, duplicateOccurrences, copyOccurrences, paste, undo, redo, select, occurrencesIn, periodDays, monthRange, importIcsFile, exportCalendar, clearSelection, toast } from './store';
import { newEventNow } from './components/Sidebar';
import { toggleAvailability, stopAvailability } from './availability';
import { Key, translate } from './i18n';
import { appShortcut, shortcutKeycaps, matchesAppShortcut } from '../../../../shared/app-shortcuts';
import { requestShellAction } from '../../workbench/commands/shell-actions';
import { registerCommands } from '../../workbench/commands/registry';
import { isMac } from './platform';

export interface Command { id: string; label: Key; labelVars?: Record<string, string | number>; section: 'secCalendar' | 'secNavigation' | 'secView' | 'secPrefs' | 'secEvent'; keys?: string[]; run: () => void; when?: () => boolean }
const hasSel = () => getState().selected.length > 0;
export const MOD = isMac ? '⌘' : 'Ctrl';
export const COMMANDS: Command[] = ([
  { id: 'create', label: 'createEvent', section: 'secCalendar', run: () => newEventNow() },
  { id: 'import', label: 'importIcs', section: 'secCalendar', run: () => importIcsFile() },
  { id: 'export', label: 'exportIcs', section: 'secCalendar', run: () => exportCalendar() },
  { id: 'availability', label: 'shareAvail', section: 'secCalendar', run: () => toggleAvailability() },
  { id: 'goto', label: 'goToDate', section: 'secNavigation', run: () => openOverlay('goto') },
  { id: 'today', label: 'goToday', section: 'secNavigation', run: () => goToday() },
  { id: 'next', label: 'nextPeriod', section: 'secNavigation', run: () => step(1) },
  { id: 'prev', label: 'prevPeriod', section: 'secNavigation', run: () => step(-1) },
  { id: 'day', label: 'switchDay', section: 'secView', run: () => setView('default', 1) },
  { id: 'week', label: 'switchWeek', section: 'secView', run: () => setView('default', 7) },
  { id: 'month', label: 'switchMonth', section: 'secView', run: () => setView('month') },
  ...[2, 3, 4, 5, 6, 8, 9].map((n): Command => ({ id: `days${n}`, label: 'switchNDays', labelVars: { n }, section: 'secView', run: () => setView('default', n) })),
  { id: 'zoomIn', label: 'zoomIn', section: 'secView', run: () => zoom(1) },
  { id: 'zoomOut', label: 'zoomOut', section: 'secView', run: () => zoom(-1) },
  { id: 'zoomReset', label: 'zoomReset', section: 'secView', run: () => zoom(0) },
  { id: 'allday', label: 'toggleAllDay', section: 'secView', run: () => setPrefs({ collapseAllDaySection: !getState().prefs.collapseAllDaySection }) },
  { id: 'weekends', label: 'showWeekends', section: 'secView', run: () => setPrefs({ showWeekends: !getState().prefs.showWeekends }) },
  { id: 'declined', label: 'showDeclined', section: 'secView', run: () => setPrefs({ showDeclined: !getState().prefs.showDeclined }) },
  { id: 'sidebar', label: 'toggleSidebar', section: 'secView', run: () => requestShellAction('toggle-sidebar') },
  { id: 'panel', label: 'sPanel', section: 'secView', run: () => setPrefs({ contextPanel: !getState().prefs.contextPanel }) },
  { id: 'theme', label: 'toggleTheme', section: 'secPrefs', run: () => requestShellAction('toggle-theme') },
  { id: 'shortcuts', label: 'allShortcuts', section: 'secPrefs', run: () => openOverlay('shortcuts') },
  { id: 'delete', label: 'deleteEvent', section: 'secEvent', run: () => deleteOccurrences(getState().selected), when: hasSel },
  { id: 'duplicate', label: 'duplicateEvent', section: 'secEvent', run: () => duplicateOccurrences(getState().selected), when: hasSel },
] satisfies Command[]).map(command => ({ ...command, keys: ['import', 'export'].includes(command.id) ? undefined : shortcutKeycaps(appShortcut(`calendar.${command.id}`), isMac) }));

export function registerCalendarCommands(): () => void {
  return registerCommands('calendar', COMMANDS.filter(command => !['delete', 'duplicate', 'sidebar', 'theme'].includes(command.id)).map(command => ({
    id: `calendar.${command.id}`, title: translate('zh-CN', command.label, command.labelVars),
    keywords: [command.id, '日历', ...(command.id === 'import' || command.id === 'export' ? ['ICS'] : [])],
    shortcut: command.keys ? appShortcut(`calendar.${command.id}`) : undefined,
    when: { mode: 'calendar' }, run: command.run,
  })));
}
export function runCommand(id: string) { const c = COMMANDS.find((x) => x.id === id); if (c && (!c.when || c.when())) { c.run(); return true; } return false; }

function editable(el: EventTarget | null) {
  const e = el as HTMLElement | null; if (!e) return false;
  return e.isContentEditable || e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT';
}
export function selectAllVisible() {
  const s = getState(); let from: number, to: number;
  if (s.prefs.gridView === 'month') { const r = monthRange(s); from = r.first; to = r.first + 42; } else { const d = periodDays(s); from = d[0]; to = d[d.length - 1] + 1; }
  select(occurrencesIn(from, to).map((o) => o.key));
}
let seq: { k: string; t: number } | null = null;
/** `e` + key: focus or open the matching field of the open event panel (data-field attributes in Panel.tsx). */
function editField(k: string): boolean {
  const s = getState(); if (!s.editing && s.selected.length === 1) setState({ editing: s.selected[0] });
  const go = () => {
    if (k === 't') { const el = document.querySelector<HTMLElement>('[data-testid=ev-title]'); el?.focus(); return; }
    if (['z', 'r', 'a'].includes(k) && !document.querySelector(`[data-field=${k}]`)) (document.querySelector('[data-field=x]') as HTMLElement | null)?.click();
    requestAnimationFrame(() => { const el = document.querySelector<HTMLElement>(`[data-field=${k === 'd' ? 'd' : k}]`); if (!el) return; if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.focus(); else if (el.tagName === 'LABEL') (el.querySelector('input') as HTMLInputElement | null)?.showPicker?.(); else el.click(); });
  };
  requestAnimationFrame(go); return true;
}
/** ⌘J: open the video link of the selected event, or of the next event with one today. */
export function joinNext(): boolean {
  const s = getState(); const now = Date.now();
  const sel = s.selected.length === 1 ? occurrencesIn(s.today - 400, s.today + 400).find((o) => o.key === s.selected[0]) : undefined;
  const o = sel?.event.conferenceUrl ? sel : occurrencesIn(s.today, s.today + 1).filter((x) => x.event.conferenceUrl && x.end > now).sort((a, b) => a.start - b.start)[0];
  if (!o?.event.conferenceUrl) return false;
  // In Ready's own browser, not the system one (W4 §4).
  void openReadyRef({ kind: 'web', url: o.event.conferenceUrl }, 'calendar').catch(error=>toast(String(error))); return true;
}
/** Global keyboard handler. Returns true when handled. */
export function handleKey(e: KeyboardEvent): boolean {
  const s = getState(); const mod = isMac ? e.metaKey : e.ctrlKey; const k = e.key;
  if(s.scopeAsk){if(k==='Escape'){s.scopeAsk.resolve(null);return true}return false}
  if (k === 'Escape') {
    if (s.menu) { setState({ menu: null }); return true; }
    if (s.overlay) { setState({ overlay: null }); return true; }
    if (editable(e.target)) { (e.target as HTMLElement).blur(); return true; }
    if (s.selected.length) { clearSelection(); return true; }
    if (s.avail.active) { stopAvailability(); return true; }
    return false;
  }
  if (mod && k === 'Enter' && !s.overlay) { const a = document.activeElement as HTMLElement | null; if (editable(a)) { a!.blur(); setState({ draftId: null }); return true; } return false; }
  // The shell owns settings, theme and object search, even inside a calendar editor.
  if (['open-settings', 'toggle-theme', 'open-search'].some(id => matchesAppShortcut(appShortcut(id), e))) return false;
  if (mod && e.shiftKey && (k === '>' || k === '.')) { zoom(1); return true; }
  if (mod && e.shiftKey && (k === '<' || k === ',')) { zoom(-1); return true; }
  if (mod && e.shiftKey && (k === ')' || k === '0')) { zoom(0); return true; }
  if (mod && e.shiftKey && k.toLowerCase() === 'l') { return runCommand('theme'); }
  if (mod && e.shiftKey && k.toLowerCase() === 'a') { return runCommand('allday'); }
  if (mod && e.shiftKey && k.toLowerCase() === 'e') { return runCommand('weekends'); }
  if (mod && e.shiftKey && k.toLowerCase() === 'd') { return runCommand('declined'); }
  if (matchesAppShortcut(appShortcut('calendar.panel'), { key: e.code === 'Backslash' ? '\\' : k, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey })) { return runCommand('panel'); }
  if (editable(e.target) || s.overlay) return false;
  if (mod && k.toLowerCase() === 'z') { if (e.shiftKey) redo(); else undo(); return true; }
  if (mod && k.toLowerCase() === 'y') { redo(); return true; }
  if (mod && k.toLowerCase() === 'a') { selectAllVisible(); return true; }
  if (mod && k.toLowerCase() === 'd') { return runCommand('duplicate'); }
  if (mod && k.toLowerCase() === 'c') { if (s.selected.length) { copyOccurrences(s.selected); return true; } return false; }
  if (mod && k.toLowerCase() === 'x') { if (s.selected.length) { copyOccurrences(s.selected, true); return true; } return false; }
  if (mod && k.toLowerCase() === 'v') { paste(); return true; }
  if (mod && k.toLowerCase() === 'f') { openOverlay('search'); return true; }
  if ((k === 'Backspace' || k === 'Delete') && s.selected.length) { deleteOccurrences(s.selected, mod ? { scope: 'this' } : {}); return true; }
  if (mod && k.toLowerCase() === 'j') { return joinNext(); }
  if (mod && k.toLowerCase() === 'n') { newEventNow(); return true; }
  if (e.altKey && !mod && (k.toLowerCase() === 't' || e.code === 'KeyT')) { goToday(); document.querySelector('[data-testid=timegrid] .scroller')?.dispatchEvent(new CustomEvent('tempo-scroll-now')); return true; }
  // e <field> edits a field of the open event. The old g-chords (g s, g t, g .) are gone: ⌘, opens settings, t and . remain.
  if (!(e.metaKey || e.ctrlKey || e.altKey) && seq && Date.now() - seq.t < 1200) {
    const p = seq.k; seq = null;
    if (p === 'e') return editField(k);
  }
  if (!(e.metaKey || e.ctrlKey || e.altKey) && k === 'e' && (s.editing || s.selected.length === 1)) { seq = { k, t: Date.now() }; return true; }
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  switch (k) {
    case 'd': case '1': setView('default', 1); return true;
    case 'w': case '0': setView('default', 7); return true;
    case 'm': setView('month'); return true;
    case 't': goToday(); return true;
    case 'j': case 'n': case 'ArrowRight': step(1); return true;
    case 'k': case 'p': case 'ArrowLeft': step(-1); return true;
    case 'c': newEventNow(); return true;
    case 's': toggleAvailability(); return true;
    case 'z': if (!s.prefs.additionalTimeZones.length) return false; setPrefs({ showAdditionalTz: !s.prefs.showAdditionalTz }); return true;
    case '\\': case '`': return runCommand('sidebar');
    case '?': openOverlay('shortcuts'); return true;
    case '/': openOverlay('search'); return true;
    case '.': openOverlay('goto'); return true;
    case 'Enter': if (s.selected.length === 1) { setState((x) => ({ editing: x.selected[0], focusTitle: x.focusTitle + 1 })); return true; } return false;
  }
  if (/^[2-9]$/.test(k)) { setView('default', +k); return true; }
  return false;
}
