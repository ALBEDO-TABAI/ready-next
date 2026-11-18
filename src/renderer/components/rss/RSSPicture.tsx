import { useState, type ReactNode } from 'react'
import { Play } from 'lucide-react'
import { describeRSSMedia } from '../../../shared/rss-media'
import { useRSSPicture } from '../../modules/rss/pictures'

// One picture of an RSS item, in the frame its place asks for (plan 2026-11-18 资讯配图, §4). The frame keeps its
// shape whatever the picture's own shape is, so a list does not jump when pictures arrive. An item without a
// picture, or whose picture does not load, shows `fallback` (nothing by default): no placeholder is drawn.
export type RSSPictureFrame =
  | 'thumb' | 'feature' | 'tile'                 // 订阅更新: end of the line, under a pick's words, a cover in the board
  | 'sieve-thumb' | 'sieve-hero' | 'sieve-cover' // 为你筛过的
  | 'hero' | 'strip' | 'side' | 'cover' | 'mosaic' | 'card' // 日报

/** The least a picture measures on its shorter side to count as one. */
const SMALLEST = 48

/** Frames wide enough that a picture of an unusual shape is shown whole inside them instead of being cut. */
const WHOLE: ReadonlySet<RSSPictureFrame> = new Set(['feature', 'hero', 'cover', 'sieve-hero'])

export default function RSSPicture({ itemId, link, coverImage, frame, fallback = null, inline = false }: {
  itemId: string; link: string; coverImage?: string | null; frame: RSSPictureFrame; fallback?: ReactNode
  /** Inside a button the frame is a span, since a button holds only phrasing content. */
  inline?: boolean
}) {
  const media = describeRSSMedia(link, useRSSPicture(itemId, coverImage))
  const url = media.cover.url
  const [failed, setFailed] = useState<string | null>(null)
  const [whole, setWhole] = useState<string | null>(null)
  if (!url || failed === url) return <>{fallback}</>
  const Frame = inline ? 'span' : 'figure'
  return <Frame className={`rss-cover-image rss-pic rss-pic--${frame}`} data-fit={whole === url ? 'whole' : undefined}>
    <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" draggable={false}
      onError={() => setFailed(url)}
      onLoad={event => {
        const { naturalWidth, naturalHeight } = event.currentTarget
        // A feed's "first picture" is often a counting pixel or a tiny badge: that is not a picture of the item.
        if (naturalWidth < SMALLEST || naturalHeight < SMALLEST) { setFailed(url); return }
        if (!WHOLE.has(frame)) return
        const ratio = naturalWidth / naturalHeight
        // A panorama, a square, or a picture too small to fill the frame without blurring.
        if (ratio > 2.4 || ratio < 1.2 || naturalWidth < 360) setWhole(url)
      }} />
    {media.kind === 'video' && <span className="rss-pic__play" aria-label="视频"><Play strokeWidth={0} fill="currentColor" aria-hidden /></span>}
  </Frame>
}
