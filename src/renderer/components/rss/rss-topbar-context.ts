import { createContext } from 'react'

// The head row of 资讯's panel (V11). The visible RSS view places its location (lead) and its tools into these two slots.
export const RSSTopbarContext = createContext<{ lead: HTMLElement | null; tools: HTMLElement | null }>({ lead: null, tools: null })
