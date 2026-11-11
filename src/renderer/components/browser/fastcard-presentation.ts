import { parseReadyUri, ReadyRefSchema, type ReadyRef } from '../../../shared/ready-ref'
import type { FastCardItem } from '../../../shared/fastcard'

// How a FastCard reads (W4 §6): its title, its text, where it came from and when. The shelf and the quick look share it.
export function itemTitle(item: FastCardItem): string {
  if (item.title) return item.title
  if (item.kind === 'audio') return '录音'
  if (item.kind === 'translation') return '翻译'
  if (item.kind === 'image-description') return '图片反推描述'
  if (item.kind === 'image') return item.alt || item.caption || '图片'
  if (item.kind === 'video') return item.video?.title || '视频'
  return '文字'
}

export function itemPreview(item: FastCardItem): string {
  if (item.kind === 'translation') return item.translatedText || item.originalText || ''
  if (item.kind === 'image-description') return item.description || ''
  if (item.kind === 'video') return item.video?.playableUrl || item.video?.originalUrl || item.source?.pageUrl || ''
  if (item.kind === 'image') return item.caption || item.alt || item.imageUrl || ''
  return item.text || ''
}

/** Where a card came from (W4 §6): 网页 with its site, 资讯, 书, PDF, or 快记 for what was jotted down directly. */
export function sourceLabel(item: FastCardItem): string {
  const url = item.source?.pageUrl || item.video?.pageUrl || ''
  if (!url) return '快记'
  const ready = parseReadyUri(url)
  if (ready.ok && ready.ref.kind === 'rss-item') return '资讯'
  if (ready.ok && ready.ref.kind === 'book-location') return '书'
  if (/\.pdf(?:$|[?#])/i.test(url)) return 'PDF'
  const site = item.source?.domain || item.source?.pageTitle
  return site ? `网页 · ${site}` : '网页'
}

export function timeLabel(at: number): string {
  const date = new Date(at), now = new Date()
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return date.toDateString() === now.toDateString() ? clock : `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

/** The page the card was taken from, as a reference (a Ready address or a web page), when it has one. */
export function sourceReference(item: FastCardItem): ReadyRef | null {
  const url = item.source?.pageUrl || item.video?.pageUrl || ''
  const ready = parseReadyUri(url)
  if (ready.ok) return ready.ref
  return ReadyRefSchema.safeParse({ kind: 'web', url }).data ?? null
}
