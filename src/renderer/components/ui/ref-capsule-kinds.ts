import {
  BookOpen, CalendarClock, CalendarDays, File, FileText, Globe, Highlighter, Inbox, MessageSquare, Newspaper, Shapes, Table2,
  type LucideIcon,
} from 'lucide-react'
import type { ReadyRef } from '../../../shared/ready-ref'

// The reference capsule's types (W6 §2.1): the Chinese name and the Lucide icon of each kind of Ready object.
export type RefCapsuleKind = 'page' | 'database' | 'canvas' | 'file' | 'book' | 'highlight' | 'rss' | 'event' | 'day' | 'web' | 'conversation' | 'fastcard'
export const REF_CAPSULE_KINDS: Record<RefCapsuleKind, { label: string; icon: LucideIcon }> = {
  page: { label: '页面', icon: FileText }, database: { label: '数据库', icon: Table2 }, canvas: { label: '画板', icon: Shapes },
  file: { label: '文件', icon: File }, book: { label: '书', icon: BookOpen }, highlight: { label: '划线', icon: Highlighter },
  rss: { label: '资讯', icon: Newspaper }, event: { label: '日程', icon: CalendarClock }, day: { label: '日期', icon: CalendarDays },
  web: { label: '网页', icon: Globe }, conversation: { label: '对话', icon: MessageSquare }, fastcard: { label: '收集', icon: Inbox },
}

/** The capsule's type. `hint` refines what the reference alone cannot tell: a search type label or a file name. */
export function refCapsuleKind(ref: Pick<ReadyRef, 'kind'> & { anchor?: string }, hint?: string): RefCapsuleKind {
  switch (ref.kind) {
    case 'page': return hint === '数据库' ? 'database' : ref.anchor?.startsWith('^hl-') || hint === '划线' ? 'highlight' : 'page'
    case 'file': return hint === '画板' || /\.canvas$/i.test(hint ?? '') ? 'canvas' : 'file'
    case 'canvas': return 'canvas'
    case 'book-location': return 'book'
    case 'rss-calibration': case 'rss-item': case 'rss-digest': case 'rss-query': return 'rss'
    case 'event': return 'event'
    case 'day': return 'day'
    case 'web': return 'web'
    case 'conversation': return 'conversation'
    case 'fastcard': return 'fastcard'
  }
  return 'page'
}

/** A capsule's reference, or a way to find it (a [[wiki]] link in the editor resolves against the vault). */
export type RefSource = ReadyRef | (() => Promise<ReadyRef>)
export const resolveRefSource = (source: RefSource) => typeof source === 'function' ? source() : Promise.resolve(source)

