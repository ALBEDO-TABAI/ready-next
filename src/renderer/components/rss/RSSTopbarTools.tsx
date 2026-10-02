import { useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { RSSTopbarContext } from './rss-topbar-context'

export default function RSSTopbarTools({ children, show = true, slot = 'tools' }: { children: ReactNode; show?: boolean; slot?: 'lead' | 'tools' }) {
  const target = useContext(RSSTopbarContext)[slot]
  return show && target ? createPortal(children, target) : null
}
