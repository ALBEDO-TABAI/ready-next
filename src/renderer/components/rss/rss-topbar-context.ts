import { createContext } from 'react'

// The RSS top bar sits on the canvas outside the rounded content frame (like Document's path bar).
// The visible RSS view places its location (lead) and its tools into these two slots.
export const RSSTopbarContext = createContext<{ lead: HTMLElement | null; tools: HTMLElement | null }>({ lead: null, tools: null })
