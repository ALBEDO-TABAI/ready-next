import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import VirtualList, { type ListRef } from 'rc-virtual-list'
import type { RSSItem } from './RSSFeed'

// Keep the real scrolling element as the source for RSS floating glass panels.
const ScrollHolder = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ScrollHolder(props, ref) {
  return <div {...props} ref={ref} data-liquid-scroll-root="rss-feed-list" className={`${props.className || ''} rss-feed-scroll`} />
})

export default function RSSVirtualList({ items, selectedItemId, children }: {
  items: RSSItem[]
  selectedItemId: string | null
  children: (item: RSSItem) => ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<ListRef>(null)
  const [height, setHeight] = useState(600)
  const scrollFrameRef = useRef<number | null>(null)
  const anchorRef = useRef<{ key: string; offset: number } | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current!
    const measure = () => {
      // Hidden workbench scenes have zero height. Retain the last viewport.
      if (container.clientHeight > 0) setHeight(container.clientHeight)
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
    if (anchor && items.some((item) => item.id === anchor.key)) {
      listRef.current?.scrollTo({ key: anchor.key, align: 'top', offset: anchor.offset })
    }
  }, [items])

  useEffect(() => {
    if (selectedItemId) listRef.current?.scrollTo({ key: selectedItemId, align: 'auto' })
  }, [selectedItemId])

  return (
    <div ref={containerRef} className="h-full min-h-0">
      <VirtualList
        ref={listRef}
        data={items}
        height={height}
        itemHeight={84}
        itemKey="id"
        component={ScrollHolder}
        onScroll={(event) => {
          const holder = event.currentTarget
          if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
          scrollFrameRef.current = requestAnimationFrame(() => {
            scrollFrameRef.current = null
            const top = holder.getBoundingClientRect().top
            const row = Array.from(holder.querySelectorAll<HTMLElement>('[data-rss-item-id]'))
              .find((element) => element.getBoundingClientRect().bottom > top)
            if (row) anchorRef.current = { key: row.dataset.rssItemId!, offset: row.getBoundingClientRect().top - top }
          })
        }}
      >
        {(item, index) => (
          <div data-rss-item-id={item.id} style={{ padding: `${index === 0 ? 12 : 4}px 8px ${index === items.length - 1 ? 12 : 4}px` }}>
            {children(item)}
          </div>
        )}
      </VirtualList>
    </div>
  )
}
