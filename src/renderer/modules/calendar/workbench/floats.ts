import { openFloat, type FloatAnchor, type FloatSpec } from '../../../components/ui/float/float-store';

// The calendar's menus, pickers and dialogs open in the app's one float layer (W1 §4–§5, DL4): the float material,
// placement, outside click, Esc and the native web view stepping aside all come from components/ui/float.

/** A point (a right click) or a rectangle (the control that opened it). */
export type At = FloatAnchor | { x: number; y: number };
export const anchorAt = (at: At): FloatAnchor => ('left' in at ? at : { left: at.x, top: at.y, right: at.x, bottom: at.y });

/** After a calendar float closes, keyboard focus goes back to the calendar so its shortcuts keep working. */
export function refocusCalendar() {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.querySelector<HTMLElement>('[data-testid=ready-calendar]')?.focus({ preventScroll: true });
  }, 0);
}

export function openCalendarFloat(spec: FloatSpec): string {
  return openFloat({ ...spec, onClose: () => { spec.onClose?.(); refocusCalendar(); } });
}
