import { create } from 'zustand'

interface CalendarConflictSnapshot {
  hasConflict: boolean
  reason: string | null
}

interface CalendarSessionState {
  visibleRangeStart: string | null
  visibleRangeEnd: string | null
  selectedEventId: string | null
  selectedEventTitle: string | null
  lastMutationAt: number | null
  conflictState: CalendarConflictSnapshot
  setVisibleRange: (start: string, end: string) => void
  setSelectedEvent: (payload: { id?: string | null; title?: string | null }) => void
  setConflictState: (payload: Partial<CalendarConflictSnapshot>) => void
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
  setVisibleRange: (start, end) => set({
    visibleRangeStart: start,
    visibleRangeEnd: end,
  }),
  setSelectedEvent: (payload) => set((state) => ({
    selectedEventId: payload.id ?? state.selectedEventId,
    selectedEventTitle: payload.title ?? state.selectedEventTitle,
  })),
  setConflictState: (payload) => set((state) => ({
    conflictState: {
      ...state.conflictState,
      ...payload,
    },
  })),
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
  }),
}))
