import { create } from 'zustand'
import type { FastCardItem } from '../../shared/fastcard'

interface FastCardSnapshot {
  items: FastCardItem[]
  panelOpen: boolean
  collapsed: boolean
}

interface FastCardState extends FastCardSnapshot {
  addItem: (item: FastCardItem) => void
  removeItem: (id: string) => void
  clear: () => void
  open: () => void
  collapse: () => void
}

const FASTCARD_SESSION_KEY = 'ready-fastcard-session-v1'

function readSnapshot(): FastCardSnapshot {
  const fallback: FastCardSnapshot = { items: [], panelOpen: false, collapsed: true }
  if (typeof sessionStorage === 'undefined') return fallback
  try {
    const raw = sessionStorage.getItem(FASTCARD_SESSION_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<FastCardSnapshot>
    return {
      items: Array.isArray(parsed.items) ? parsed.items.filter((item) => item?.id && item.kind) as FastCardItem[] : [],
      panelOpen: Boolean(parsed.panelOpen),
      collapsed: parsed.collapsed !== false,
    }
  } catch {
    return fallback
  }
}

function writeSnapshot(snapshot: FastCardSnapshot): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(FASTCARD_SESSION_KEY, JSON.stringify(snapshot))
  } catch {
    // silent-catch: session-only cache; storage failures should not break browser use.
  }
}

function persist(next: FastCardSnapshot): FastCardSnapshot {
  writeSnapshot(next)
  return next
}

const initialSnapshot = readSnapshot()

export const useFastCard = create<FastCardState>((set) => ({
  ...initialSnapshot,
  addItem: (item) => set((state) => persist({
    items: [item, ...state.items],
    panelOpen: true,
    collapsed: false,
  })),
  removeItem: (id) => set((state) => persist({
    ...state,
    items: state.items.filter((item) => item.id !== id),
  })),
  clear: () => set((state) => persist({
    ...state,
    items: [],
  })),
  open: () => set((state) => persist({
    ...state,
    panelOpen: true,
    collapsed: false,
  })),
  collapse: () => set((state) => persist({
    ...state,
    panelOpen: false,
    collapsed: true,
  })),
}))
