import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import VirtualList, { type ListRef } from 'rc-virtual-list'
import { Archive, Bookmark, Check } from 'lucide-react'
import type { RSSItem } from './RSSFeed'
import { ScrollHolder } from './RSSVirtualList'
import RSSPicture from './RSSPicture'
import { IconButton } from '../ui/Button'
import { cardTimeLabel, coverWords, itemDragHandlers } from '../../modules/rss/feed-item'
import { galleryColumns, galleryRows, type GalleryRow } from '../../modules/rss/gallery-rows'
import { isRSSFeedItemContentEqual } from '../../modules/rss/rssFeedItemEquality'

// 图册 (plan 2026-11-18 资讯配图, P10): the same items as a board of covers. Each cover is the item's picture, or
// its own summary where it has none, with the time, the source and two lines of title under it. Rows of covers are
// what the list virtualises, so a long feed costs no more here than in 列表; a new day starts a new row.

interface TileProps {
  item: RSSItem
  selected: boolean
  curatedIds: string
  onItemClick: (item: RSSItem) => void
  onMarkItemRead: (itemId: string) => void
  onToggleStar: (itemId: string) => void
  onDeleteItem: (itemId: string) => void
}

const RSSGalleryTile = memo(function RSSGalleryTile({ item, selected, curatedIds, onItemClick, onMarkItemRead, onToggleStar, onDeleteItem }: TileProps) {
  const curated = new Set(curatedIds ? curatedIds.split(',') : [])
  const curation = (item.classifications || []).find((entry) => entry.included && curated.has(entry.definitionId))
  const words = coverWords(item)
  const reports = item.eventGroup && item.eventGroup.memberCount > 1 ? item.eventGroup.memberCount : 0
  return (
    <article data-rss-item-id={item.id} className={`rss-tile${item.read ? ' is-read' : ''}${selected ? ' is-selected' : ''}`} onClick={() => onItemClick(item)} {...itemDragHandlers(item)}>
      <RSSPicture itemId={item.id} link={item.link} coverImage={item.coverImage} frame="tile"
        fallback={<div className={`rss-pic rss-pic--tile rss-pic--words${words.site ? ' is-site' : ''}`}><p>{words.text}</p></div>} />
      <div className="rss-tile__meta">
        {!item.read && <i className="rss-tile__dot" aria-hidden />}
        <time>{cardTimeLabel(item)}</time>
        <span className="rss-tile__source" title={item.source}>{item.source}{item.author && item.author !== item.source ? ` · ${item.author}` : ''}{reports ? ` · ${reports} 篇报道` : ''}</span>
        {curation && <span className="rss-card-curated" title={curation.reason}>精选</span>}
      </div>
      <h3 className="rss-tile__title"><button type="button" className="text-left">{item.title}</button></h3>
      <div className="rss-tile__actions" onClick={(event) => event.stopPropagation()}>
        {!item.read && <IconButton size="sm" icon={<Check />} onClick={() => onMarkItemRead(item.id)} title="标记为已读" />}
        {item.inboxVisible !== false && <IconButton size="sm" icon={<Archive />} onClick={() => onDeleteItem(item.id)} title={item.starred ? '移出收件箱（收藏会继续显示）' : '移出收件箱'} />}
        <IconButton size="sm" active={item.starred} icon={<Bookmark fill={item.starred ? 'currentColor' : 'none'} />} onClick={() => onToggleStar(item.id)} title={item.starred ? '取消收藏' : '收藏'} />
      </div>
    </article>
  )
}, (previous, next) => previous.selected === next.selected && previous.curatedIds === next.curatedIds
  && previous.onItemClick === next.onItemClick && previous.onMarkItemRead === next.onMarkItemRead
  && previous.onToggleStar === next.onToggleStar && previous.onDeleteItem === next.onDeleteItem
  && isRSSFeedItemContentEqual(previous.item, next.item))

const HEADER_ROW: GalleryRow = { key: 'rss-gallery-header', heading: null, items: [] }

export default function RSSFeedGallery({ items, selectedItemId, header = null, curatedIds, onItemClick, onMarkItemRead, onToggleStar, onDeleteItem }: {
  items: RSSItem[]
  selectedItemId: string | null
  /** Scrolls with the board as its first row (当前热点). */
  header?: ReactNode
} & Omit<TileProps, 'item' | 'selected'>) {
  const container = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 900, height: 600 })
  useLayoutEffect(() => {
    const element = container.current!
    // A hidden workbench scene measures zero: keep the last real size.
    const measure = () => setSize((old) => {
      const width = element.clientWidth || old.width, height = element.clientHeight || old.height
      return width === old.width && height === old.height ? old : { width, height }
    })
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [])
  const columns = galleryColumns(size.width)
  const rows = useMemo(() => { const built = galleryRows(items, columns); return header ? [HEADER_ROW, ...built] : built }, [items, columns, header])
  // The reader's place is the first cover of the top row and how far that row has scrolled. It is put back when the
  // rows are rebuilt: after a reload, after coming back from an article (a hidden board loses its scroll position),
  // and when the number of columns changes, where the same cover now starts or sits in another row.
  const list = useRef<ListRef>(null), place = useRef<{ itemId: string; offset: number } | null>(null), frame = useRef<number | null>(null)
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }, [])
  useLayoutEffect(() => {
    const kept = place.current, row = kept && rows.find((candidate) => candidate.items.some((item) => item.id === kept.itemId))
    if (kept && row) list.current?.scrollTo({ key: row.key, align: 'top', offset: kept.offset })
  }, [rows, size.height])
  return (
    <div ref={container} className="flex-1 min-h-0">
      <VirtualList ref={list} data={rows} height={size.height} itemHeight={268} itemKey="key" component={ScrollHolder}
        onScroll={(event) => {
          const holder = event.currentTarget
          if (frame.current !== null) cancelAnimationFrame(frame.current)
          frame.current = requestAnimationFrame(() => {
            frame.current = null
            const top = holder.getBoundingClientRect().top
            const row = Array.from(holder.querySelectorAll<HTMLElement>('.rss-gallery__row')).find((element) => element.getBoundingClientRect().bottom > top)
            const itemId = row?.querySelector<HTMLElement>('[data-rss-item-id]')?.dataset.rssItemId
            if (row && itemId) place.current = { itemId, offset: row.getBoundingClientRect().top - top }
          })
        }}>
        {(row, index) => row === HEADER_ROW
          ? <div data-rss-row-key={row.key} className="rss-feed-row rss-feed-row--header">{header}</div>
          : (
            <div data-rss-row-key={row.key} className="rss-gallery__row" data-last={index === rows.length - 1 || undefined}>
              {row.heading && <h2 className="rss-date-heading">{row.heading.main}{row.heading.detail ? <small>{row.heading.detail}</small> : null}</h2>}
              <div className="rss-gallery__covers" style={{ '--rss-gallery-columns': columns } as CSSProperties}>
                {row.items.map((item) => <RSSGalleryTile key={item.id} item={item} selected={selectedItemId === item.id} curatedIds={curatedIds}
                  onItemClick={onItemClick} onMarkItemRead={onMarkItemRead} onToggleStar={onToggleStar} onDeleteItem={onDeleteItem} />)}
              </div>
            </div>
          )}
      </VirtualList>
    </div>
  )
}
