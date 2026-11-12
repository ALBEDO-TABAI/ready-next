import { withoutOpenRecording } from './navigation-open-event'
import { useRSSSession } from '../../stores/useRSSSession'
import { useFastCard } from '../../stores/useFastCard'
import { revealConversation } from '../agent/conversation-navigation'
import { create } from 'zustand'
import { parsePdfAnchor, type PdfAnchor } from '../../../shared/pdf-source-anchor'
import { useMentionNavigation } from '../calendar/workbench/layers/mention-navigation'
import { requestCanvasNode } from '../canvas/navigation'
import { rssReferenceFromReadyRef } from '../../../shared/rss-reference'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { parseReadyUri, ReadyRefSchema, type ReadyRef } from '../../../shared/ready-ref'
import { calendarEventReferenceId } from '../../../shared/calendar-event-identity'
import { revealRSSReference } from '../rss/reveal-reference'
import { openWebpageInBrowser } from '../browser/openWebpageInBrowser'
import { useWorkspace } from '../../stores/useWorkspace'
import { useDocTabs } from '../../stores/useDocTabs'
import { getLibraryAPI, confirmed } from '../library/access'
import { parseBookLocation } from '../library/reader/location'
import { requestBookLocation } from '../library/reader/navigation-state'
import { requestWorkbenchModeOpen } from './mode-transition'
import { navigationHistory, currentNavigationOrigin } from './navigation-history'
import { drafts } from '../document/drafts/runtime'
import { openInCurrentTab } from '../document/ink/layout-state'

export const usePdfReference = create<{ target: { id: string; path: string; anchor: PdfAnchor } | null }>(() => ({ target: null }))

/**
 * All Ready reference entry points share validation and destination owners. `newTab` (⌘-click, ⌘↵) keeps the current
 * document tab and opens pages, files and boards in a tab of their own, as Inkwell does; the document mode has no
 * second pane to open into, and the other destinations have no tabs, so for them it opens as usual.
 */
export async function openReadyRef(input: string | ReadyRef, fromMode?: WorkbenchMode, options: { newTab?: boolean } = {}): Promise<void> {
  const parsed = typeof input === 'string' ? parseReadyUri(input) : { ok: true as const, ref: ReadyRefSchema.parse(input) }
  if (!parsed.ok) throw new Error('引用地址无效')
  await navigationHistory.load()
  const ref = parsed.ref, origin = await currentNavigationOrigin(fromMode)
  const mode: WorkbenchMode = ['page', 'file', 'canvas', 'book-location', 'draft'].includes(ref.kind) ? 'document'
    : ref.kind.startsWith('rss-') ? 'rss' : ref.kind === 'event' || ref.kind === 'day' ? 'calendar' : ref.kind === 'web' ? 'browser' : useMode.getState().workbenchMode
  const entry = { mode, ref, title: '打开的对象', openedAt: Date.now(), anchor: [] }
  await navigationHistory.open(entry, async () => { entry.title = await withoutOpenRecording(() => openReadyRefDestination(ref, fromMode, options)) }, origin)
}

/** Replay bypasses recording and the per-tab push, but uses the same destination validation. */
export async function openReadyRefDestination(ref: ReadyRef, fromMode = useMode.getState().workbenchMode, { newTab = false, record = true }: { newTab?: boolean; record?: boolean } = {}): Promise<string> {
  const origin = { mode: fromMode }
  switch (ref.kind) {
    case 'rss-calibration': {
      const result = await window.electronAPI.rss.sieveCalibration()
      if (!result.success) throw new Error(result.error)
      if (result.data?.week !== ref.id || result.data.status !== 'pending') throw new Error('校准提案已失效')
      useRSSSession.getState().requestCalibration(ref.id)
      requestWorkbenchModeOpen('rss')
      return '筛子校准'
    }
    case 'draft': {
      const result = await window.electronAPI.documentDrafts.read(ref.id)
      if (!result.ok) throw new Error(result.message)
      if (!result.value || !['editing', 'conflict', 'finalizing'].includes(result.value.state)) throw new Error('草稿已不可用')
      const existing = useDocTabs.getState().tabs.find(tab => tab.draftId === ref.id)
      const id = existing?.id ?? useDocTabs.getState().createBackgroundTab({ title: result.value.title })
      if (!existing) await drafts.attach(id, result.value)
      useDocTabs.getState().setActiveTab(id)
      requestWorkbenchModeOpen('document')
      return result.value.title || '未保存的草稿'
    }

    case 'book-location': {
      const location = parseBookLocation(ref.loc)
      const state = confirmed(await getLibraryAPI().get())
      const book = state.status === 'ready' && state.books.find(b => b.id === ref.book)
      if (!book) throw new Error('书籍不存在或已从书房移除')
      if (!['epub', 'txt', 'md'].includes(book.format)) {
        if (ref.loc !== 'c0:0+1') throw new Error('此书籍格式暂不支持段落定位')
        useDocTabs.getState().openTab(book.filePath)
        useWorkspace.getState().selectFile(book.filePath)
        requestWorkbenchModeOpen('document')
        return book.title || '书籍'
      }
      requestBookLocation({ book: ref.book, location })
      useWorkspace.getState().selectFile(null)
      useDocTabs.getState().openLibraryTab()
      requestWorkbenchModeOpen('document')
      return book.title || '书籍'
    }
    case 'canvas':
    case 'page':
    case 'file': {
      const location = await window.electronAPI.objects.locate(ref.id)
      if (!location) throw new Error('引用文档已不存在')
      if (ref.kind === 'file' && ref.anchor?.startsWith('pdf:')) {
        if (!/\.pdf$/i.test(location.path)) throw new Error('引用对象已不是 PDF')
        const anchor = parsePdfAnchor(ref.anchor)
        usePdfReference.setState({ target: { id: ref.id, path: location.path, anchor } })
        if (origin.mode === 'document') openInCurrentTab(location.path, { newTab, record })
        else useDocTabs.getState().openTab(location.path)
        useWorkspace.getState().selectFile(location.path)
        requestWorkbenchModeOpen('document')
        return location.path.split(/[\\/]/).pop()!.replace(/\.(md|canvas)$/i, '')
      }
      if (ref.kind === 'file' && ref.anchor?.startsWith('date-mention:')) {
        const target = await window.electronAPI.dateMentions.locate(ref)
        useWorkspace.getState().selectFile(target.path)
        useDocTabs.getState().openTab(target.path)
        useMentionNavigation.setState({ target })
        requestWorkbenchModeOpen('document')
        return location.path.split(/[\\/]/).pop()!.replace(/\.(md|canvas)$/i, '')
      }
      // A missing heading or block still opens the page; only the scroll target is dropped.
      const reveal = ref.kind !== 'canvas' && ref.anchor ? await anchorLines(location.path, ref.anchor) : null
      if (ref.kind === 'canvas') requestCanvasNode(ref.id, ref.node)
      // A link followed inside Document mode navigates the current tab, as in Inkwell; other modes open a tab.
      if (origin.mode === 'document') openInCurrentTab(location.path, { newTab, record })
      else useDocTabs.getState().openTab(location.path)
      useWorkspace.getState().selectFile(location.path)
      if (reveal) useDocTabs.getState().setPendingReveal({ path: location.path, ...reveal, requestedAt: Date.now() })
      requestWorkbenchModeOpen('document')
      return location.path.split(/[\\/]/).pop()!.replace(/\.(md|canvas)$/i, '')
    }
    case 'fastcard':
      if (!await useFastCard.getState().reveal(ref.id)) throw new Error('暂存条目无法打开')
      return useFastCard.getState().items.find(item => item.id === ref.id)?.title || '收集'
    case 'rss-query': {
      const result = await window.electronAPI.rss.queryItems(ref.query)
      if (!result.success || !result.data) throw new Error(result.error || '资讯查询无法打开')
      revealRSSReference({ kind: 'query', query: ref.query })
      return '资讯查询'
    }
    case 'rss-digest':
    case 'rss-item': {
      const reference = rssReferenceFromReadyRef(ref)
      if (reference && reference.kind !== 'query') {
        const api = window.electronAPI.rss
        const result = reference.kind === 'excerpt' ? await api.readExcerpt(reference.read)
          : reference.kind === 'article' ? await api.readArticle(reference.read)
          : await api.readDigests({ view: 'entries', ...reference.read })
        if (!result.success || !result.data) throw new Error(result.error || 'RSS 引用无法打开')
        revealRSSReference(reference)
        return 'article' in result.data ? result.data.article.title : '资讯摘要'
      }
      const result = await window.electronAPI.rss.readArticle({ itemId: ref.id, length: 1 })
      if (!result.success || !result.data) throw new Error(result.error || '文章无法打开')
      revealRSSReference({ kind: 'article', read: { itemId: ref.id, expectedRevision: result.data.article.revision, offset: 0, length: 1 } })
      return result.data.article.title
    }
    case 'event': {
      const id = calendarEventReferenceId(ref)
      const result = await window.electronAPI.calendar.revealEvent(id)
      if (!result.success) throw new Error(result.error || '日程无法打开')
      requestWorkbenchModeOpen('calendar')
      const snapshot = await window.electronAPI.calendar.snapshot()
      if (!snapshot.success || !snapshot.data) throw new Error(snapshot.error || '日程不可用')
      return snapshot.data.events.find(event => event.id === ref.id)?.title || '日程'
    }
    case 'day': {
      const result = await window.electronAPI.calendar.revealDay(ref.date)
      if (!result.success) throw new Error(result.error || '日期无法打开')
      requestWorkbenchModeOpen('calendar')
      return ref.date
    }
    case 'conversation': {
      await revealConversation(ref)
      if (!useWorkspace.getState().chatPanelVisible) useWorkspace.getState().toggleChatPanel()
      return '对话'
    }
    case 'web':
      if (!await openWebpageInBrowser(ref.url)) throw new Error('网页未能在 Ready 浏览器中打开')
      return ref.url
    default: throw new Error('暂不支持打开此类引用')
  }
}

export async function openIndexedSearchResult(item: { path: string; sourceType: string }): Promise<void> {
  const parsed = parseReadyUri(item.path)
  if (!parsed.ok) throw new Error('搜索结果地址无效')
  const kinds: Record<string, ReadyRef['kind']> = { rss: 'rss-item', calendar: 'event', agent: 'conversation', bookmark: 'web', library: 'book-location', book: 'book-location', highlight: 'page', fastcard: 'fastcard' }
  const matches = kinds[item.sourceType] === parsed.ref.kind || (item.sourceType === 'document' && parsed.ref.kind === 'book-location')
  if (!matches) throw new Error('搜索结果类型与地址不符')
  await openReadyRef(parsed.ref)
}

/** Source lines of a page anchor: a heading (#标题) or a block id (#^id), read from the open buffer or the file. */
export async function anchorLines(path: string, anchor: string): Promise<{ lineStart: number; lineEnd: number; sectionTitle?: string } | null> {
  const open = useDocTabs.getState().tabs.find(tab => tab.path === path)
  let content = open && open.kind !== 'library' ? open.content : undefined
  if (!content) {
    const read = await window.electronAPI.document.readFile(path)
    content = read.success ? read.content ?? (read.data && 'content' in read.data ? read.data.content : undefined) : undefined
    if (typeof content !== 'string') return null
  }
  const lines = content.split(/\r\n|\n|\r/)
  if (anchor.startsWith('^')) {
    const id = anchor.slice(1)
    const index = lines.findIndex(line => line.trimEnd().endsWith(`^${id}`) && /(^|\s)\^[\w-]+$/.test(line.trimEnd()))
    if (index < 0) return null
    // A standalone ^id line labels the block above it; otherwise the id ends the block's last line.
    let end = index, start = index
    if (/^\s*\^[\w-]+\s*$/.test(lines[index])) { end = index - 1; while (end > 0 && !lines[end].trim()) end--; start = end }
    while (start > 0 && lines[start - 1].trim()) start--
    return { lineStart: start + 1, lineEnd: end + 1 }
  }
  const wanted = anchor.trim().toLowerCase()
  const index = lines.findIndex(line => /^#{1,6}\s/.test(line) && line.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim().toLowerCase() === wanted)
  return index < 0 ? null : { lineStart: index + 1, lineEnd: index + 1, sectionTitle: anchor }
}
