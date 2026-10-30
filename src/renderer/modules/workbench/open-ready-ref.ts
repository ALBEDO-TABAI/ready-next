import { useMentionNavigation } from '../calendar/workbench/layers/mention-navigation'
import { rssReferenceFromReadyRef } from '../../../shared/rss-reference'
import type { WorkbenchMode } from '../../stores/useMode'
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
import { captureReferenceOrigin, rememberReferenceOrigin } from './reference-return'

/** All Ready reference entry points share validation and destination owners. */
export async function openReadyRef(input: string | ReadyRef, fromMode?: WorkbenchMode): Promise<void> {
  const parsed = typeof input === 'string' ? parseReadyUri(input) : { ok: true as const, ref: ReadyRefSchema.parse(input) }
  if (!parsed.ok) throw new Error('引用地址无效')
  const ref = parsed.ref
  const origin = captureReferenceOrigin(fromMode)
  switch (ref.kind) {
    case 'book-location': {
      const location = parseBookLocation(ref.loc)
      const state = confirmed(await getLibraryAPI().get())
      const book = state.status === 'ready' && state.books.find(b => b.id === ref.book)
      if (!book) throw new Error('书籍不存在或已从书房移除')
      if (!['epub', 'txt', 'md'].includes(book.format)) throw new Error('此书籍格式暂不支持段落定位')
      rememberReferenceOrigin(origin, 'document')
      requestBookLocation({ book: ref.book, location })
      useWorkspace.getState().selectFile(null)
      useDocTabs.getState().openLibraryTab()
      requestWorkbenchModeOpen('document')
      return
    }
    case 'page':
    case 'file': {
      const location = await window.electronAPI.objects.locate(ref.id)
      if (!location) throw new Error('引用文档已不存在')
      if (ref.kind === 'file' && ref.anchor?.startsWith('date-mention:')) {
        const target = await window.electronAPI.dateMentions.locate(ref)
        rememberReferenceOrigin(origin, 'document')
        useWorkspace.getState().selectFile(target.path)
        useDocTabs.getState().openTab(target.path)
        useMentionNavigation.setState({ target })
        requestWorkbenchModeOpen('document')
        return
      }
      if (ref.anchor) throw new Error('此文档锚点暂不支持定位')
      rememberReferenceOrigin(origin, 'document')
      useWorkspace.getState().selectFile(location.path)
      useDocTabs.getState().openTab(location.path)
      requestWorkbenchModeOpen('document')
      return
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
        rememberReferenceOrigin(origin, 'rss')
        revealRSSReference(reference)
        return
      }
      const result = await window.electronAPI.rss.readArticle({ itemId: ref.id, length: 1 })
      if (!result.success || !result.data) throw new Error(result.error || '文章无法打开')
      rememberReferenceOrigin(origin, 'rss')
      revealRSSReference({ kind: 'article', read: { itemId: ref.id, expectedRevision: result.data.article.revision, offset: 0, length: 1 } })
      return
    }
    case 'event': {
      const id = calendarEventReferenceId(ref)
      const result = await window.electronAPI.calendar.revealEvent(id)
      if (!result.success) throw new Error(result.error || '日程无法打开')
      rememberReferenceOrigin(origin, 'calendar')
      requestWorkbenchModeOpen('calendar')
      return
    }
    case 'day': {
      const result = await window.electronAPI.calendar.revealDay(ref.date)
      if (!result.success) throw new Error(result.error || '日期无法打开')
      rememberReferenceOrigin(origin, 'calendar')
      requestWorkbenchModeOpen('calendar')
      return
    }
    case 'conversation': {
      const { revealSearchConversation } = await import('../../stores/useAgent')
      await revealSearchConversation(ref.id)
      if (!useWorkspace.getState().chatPanelVisible) useWorkspace.getState().toggleChatPanel()
      return
    }
    case 'web':
      if (!await openWebpageInBrowser(ref.url)) throw new Error('网页未能在 Ready 浏览器中打开')
      rememberReferenceOrigin(origin, 'browser')
      return
    default: throw new Error('暂不支持打开此类引用')
  }
}

export async function openIndexedSearchResult(item: { path: string; sourceType: string }): Promise<void> {
  const parsed = parseReadyUri(item.path)
  if (!parsed.ok) throw new Error('搜索结果地址无效')
  const kinds: Record<string, ReadyRef['kind']> = { rss: 'rss-item', calendar: 'event', agent: 'conversation', bookmark: 'web', library: 'book-location' }
  const matches = kinds[item.sourceType] === parsed.ref.kind || (item.sourceType === 'document' && parsed.ref.kind === 'book-location')
  if (!matches) throw new Error('搜索结果类型与地址不符')
  await openReadyRef(parsed.ref)
}
