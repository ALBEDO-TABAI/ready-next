import { create } from 'zustand'

interface CalendarConflictSnapshot {
  hasConflict: boolean
  reason: string | null
}

/**
 * L4-A — resolve the user's local IANA timezone identifier. Wrapped in a
 * try/catch so a polyfill / environment that fails to honor
 * `resolvedOptions().timeZone` (older Electron builds, broken locale
 * data) cannot crash the store initialization. We fall back to 'UTC'
 * which is a valid IANA id; the user can still pick a real zone from
 * the selector UI.
 */
function resolveLocalTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz && tz.length > 0 ? tz : 'UTC'
  } catch {
    return 'UTC'
  }
}

interface CalendarSessionState {
  visibleRangeStart: string | null
  visibleRangeEnd: string | null
  selectedEventId: string | null
  selectedEventTitle: string | null
  lastMutationAt: number | null
  conflictState: CalendarConflictSnapshot
  /**
   * L1-B-Mock-Surface — reflects whether the last successful calendar IPC
   * response was mock data (i.e. `ENABLE_MOCK_SERVICES=true` at main-process
   * start). Set by the CalendarMode fetch wrapper after `getEvents` /
   * `getSources` succeed; read by `CalendarWorkbenchShell` to surface a
   * "MOCK DATA" badge so devs cannot mistake mock data for real data.
   *
   * Default false. Error responses leave the value unchanged (the failing
   * branch shows `loadError` instead).
   */
  isMock: boolean
  /**
   * L4-A-Timezone — the IANA timezone the user has chosen for VIEWING
   * the calendar. Default is the local zone resolved at store init.
   *
   * This is decoupled from per-event `startTz / endTz` (which belong to
   * each row and identify the zone the event was authored in). The
   * display timezone is a renderer-only preference; events keep their
   * authored zone in the DB regardless of how they're rendered. The
   * `useScheduleXCalendar` hook passes this into schedule-x's
   * `timezone` config so month/week/day views render under the chosen
   * zone.
   */
  displayTimezone: string
  setVisibleRange: (start: string, end: string) => void
  setSelectedEvent: (payload: { id?: string | null; title?: string | null }) => void
  setConflictState: (payload: Partial<CalendarConflictSnapshot>) => void
  setIsMock: (value: boolean) => void
  setDisplayTimezone: (tz: string) => void
  markMutation: () => void
  reset: () => void
}

export const useCalendarSession = create<CalendarSessionState>((set) => ({
  visibleRangeStart: null,
  visibleRangeEnd: null,
  selectedEventId: null,
  selectedEventTitle: null,
  lastMutationAt: null,
  conflictState: {
    hasConflict: false,
    reason: null,
  },
  isMock: false,
  displayTimezone: resolveLocalTimezone(),
  setVisibleRange: (start, end) => set({
    visibleRangeStart: start,
    visibleRangeEnd: end,
  }),
  setSelectedEvent: (payload) => set((state) => ({
    selectedEventId: 'id' in payload ? payload.id ?? null : state.selectedEventId,
    selectedEventTitle: 'title' in payload ? payload.title ?? null : state.selectedEventTitle,
  })),
  setConflictState: (payload) => set((state) => ({
    conflictState: {
      ...state.conflictState,
      ...payload,
    },
  })),
  setIsMock: (value) => set({ isMock: value }),
  setDisplayTimezone: (tz) => set({ displayTimezone: tz }),
  markMutation: () => set({ lastMutationAt: Date.now() }),
  reset: () => set({
    visibleRangeStart: null,
    visibleRangeEnd: null,
    selectedEventId: null,
    selectedEventTitle: null,
    lastMutationAt: null,
    conflictState: {
      hasConflict: false,
      reason: null,
    },
    isMock: false,
    // Keep displayTimezone across `reset` — it's a user preference, not
    // session-bound state. (Re-init to local timezone would surprise
    // users who set a non-local view zone.)
  }),
}))
