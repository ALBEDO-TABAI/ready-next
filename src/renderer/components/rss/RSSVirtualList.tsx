import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import VirtualList, { type ListRef } from 'rc-virtual-list'
import type { RSSItem } from './RSSFeed'

// An optional header (e.g. 当前热点) scrolls with the list as its first virtual row.
const HEADER_KEY = 'rss-list-header'
const HEADER_ROW = { id: HEADER_KEY } as RSSItem
const rowKey = (item: RSSItem) => item === HEADER_ROW ? HEADER_KEY : item.eventGroup ? `event:${item.eventGroup.id}` : item.id

// Keep the real scrolling element as the source for RSS floating glass panels.
const ScrollHolder = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ScrollHolder(props, ref) {
  return <div {...props} ref={ref} data-liquid-scroll-root="rss-feed-list" className={`${props.className || ''} rss-feed-scroll`} />
})

export default function RSSVirtualList({ items, selectedItemId, children, header = null }: {
  items: RSSItem[]
  selectedItemId: string | null
  children: (item: RSSItem, index: number) => ReactNode
  header?: ReactNode
}) {
  const rows = useMemo(() => header ? [HEADER_ROW, ...items] : items, [header, items])
  const offset = header ? 1 : 0
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<ListRef>(null)
  const [height, setHeight] = useState(600)
  const scrollFrameRef = useRef<number | null>(null)
  const anchorRef = useRef<{ key: string; offset: number } | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current!
    let width = container.clientWidth
    const measure = () => {
      // Hidden workbench scenes have zero height. Retain the last viewport.
      if (container.clientHeight > 0) setHeight(container.clientHeight)
      // Cards wrap to the frame width; after a width change keep the reader's row where it was.
      if (container.clientWidth > 0 && container.clientWidth !== width) {
        width = container.clientWidth
        const anchor = anchorRef.current
        if (anchor) requestAnimationFrame(() => listRef.current?.scrollTo({ key: anchor.key, align: 'top', offset: anchor.offset }))
      }
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(container)
    return () => observer?.disconnect()
  }, [])

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (anchor && rows.some((item) => rowKey(item) === anchor.key)) {
      listRef.current?.scrollTo({ key: anchor.key, align: 'top', offset: anchor.offset })
    }
  }, [rows])

  useEffect(() => {
    const item = items.find((entry) => entry.id === selectedItemId)
    if (item) listRef.current?.scrollTo({ key: rowKey(item), align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrolls only when the selection changes; list reloads and load-more replace items and must not snap the viewport back to the selected row
  }, [selectedItemId])

  return (
    <div ref={containerRef} className="flex-1 min-h-0">
      <VirtualList
        ref={listRef}
        data={rows}
        height={height}
        itemHeight={84}
        itemKey={rowKey}
        component={ScrollHolder}
        onScroll={(event) => {
          const holder = event.currentTarget
          if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
          scrollFrameRef.current = requestAnimationFrame(() => {
            scrollFrameRef.current = null
            const top = holder.getBoundingClientRect().top
            const row = Array.from(holder.querySelectorAll<HTMLElement>('[data-rss-row-key]'))
              .find((element) => element.getBoundingClientRect().bottom > top)
            if (row) anchorRef.current = { key: row.dataset.rssRowKey!, offset: row.getBoundingClientRect().top - top }
          })
        }}
      >
        {(item, index) => item === HEADER_ROW
          ? <div data-rss-row-key={HEADER_KEY} className="rss-feed-row rss-feed-row--header">{header}</div>
          : (
            <div data-rss-row-key={rowKey(item)} className="rss-feed-row" data-first={index === offset || undefined} data-last={index === rows.length - 1 || undefined}>
              {children(item, index - offset)}
            </div>
          )}
      </VirtualList>
    </div>
  )
}
