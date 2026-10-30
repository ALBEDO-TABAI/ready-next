import { ReadyRefSchema, type ReadyRef } from '../../../../shared/ready-ref'
import { useDocTabs } from '../../../stores/useDocTabs'
import { findCalendarOccurrence } from '../../../../shared/calendar/commands'

export type ObjectPreview =
  | { state: 'ready'; title: string; body: string; markdown: boolean; unsaved: boolean }
  | { state: 'invalid' | 'unavailable'; title: string; message: string }
const invalid = (): ObjectPreview => ({ state: 'invalid', title: '引用已失效', message: '对象已删除、移入回收站或不再可用' })
const summary = (title: string, body: string): ObjectPreview => ({ state: 'ready', title, body, markdown: false, unsaved: false })

/** Read current owners; this read-only surface never saves or hydrates a tab. */
export async function loadObjectPreview(input: ReadyRef): Promise<ObjectPreview> {
  const ref = ReadyRefSchema.parse(input), api = window.electronAPI
  switch (ref.kind) {
    case 'page': case 'file': case 'canvas': {
      const location = await api.objects.locate(ref.id)
      if (!location) return invalid()
      const title = location.path.split(/[\\/]/).pop() || ref.id
      const tab = useDocTabs.getState().tabs.find(tab => tab.objectId === ref.id || tab.path === location.path)
      if (tab?.isDirty) return { state: 'ready', title: tab.title, body: tab.content, markdown: ref.kind === 'page', unsaved: true }
      if (ref.kind === 'canvas') return summary(title, '画板 · ' + location.path)
      const result = await api.document.readFile(location.path)
      if (!result.success) throw new Error(result.error || '读取失败')
      const body = result.data?.type === 'text' ? result.data.content : result.content
      return typeof body === 'string' ? { state: 'ready', title, body, markdown: ref.kind === 'page', unsaved: false }
        : summary(title, '文件 · ' + location.path)
    }
    case 'web': return summary(new URL(ref.url).hostname, ref.url)
    case 'day': return summary(ref.date, [ref.at, ref.remind === undefined ? '' : `提前 ${ref.remind} 分钟提醒`].filter(Boolean).join(' · '))
    case 'book-location': {
      const result = await api.library.get()
      if (!result.success) throw new Error(result.error)
      const book = result.data.status === 'ready' && result.data.books.find(book => book.id === ref.book)
      return book ? summary(book.title, [book.author, book.publisher, book.format, book.status].filter(Boolean).join(' · ')) : invalid()
    }
    case 'event': {
      const result = await api.calendar.snapshot()
      if (!result.success || !result.data) throw new Error(result.error || '读取日程失败')
      const occurrence = findCalendarOccurrence(result.data.events, ref.occurrence === undefined ? ref.id : `${ref.id}|${ref.occurrence}`)
      const event = occurrence?.event
      return event ? summary(event.title, [event.description, event.location, String(occurrence.start)].filter(Boolean).join('\n')) : invalid()
    }
    case 'rss-item': {
      if (ref.excerpt) {
        const result = await api.rss.readExcerpt({ ...ref.excerpt, itemId: ref.id })
        if (!result.success || !result.data) return { state: 'invalid', title: '引用已失效', message: result.error || '文章片段已变化或删除' }
        return summary('RSS 引用片段', result.data.text)
      }
      const result = await api.rss.readArticle({ itemId: ref.id, ...(ref.article ?? {}), length: 1200 })
      if (!result.success || !result.data) return { state: result.error === 'article_not_found' ? 'invalid' : 'unavailable', title: '文章无法读取', message: result.error === 'article_not_found' ? '文章已失效或删除' : result.error || '文章无法读取' }
      return summary(result.data.article.title, result.data.article.summary || result.data.article.link)
    }
    case 'rss-query': {
      const result = await api.rss.queryItems(ref.query)
      if (!result.success || !result.data) throw new Error(result.error || 'RSS 查询失败')
      return summary('RSS 查询', `${result.data.total} 篇文章\n${result.data.items.map(item => item.title).join('\n')}`)
    }
    case 'rss-digest': {
      const result = await api.rss.readDigests({ view: 'entries', reportId: ref.id, offset: ref.offset, limit: ref.limit })
      if (!result.success || !result.data) return { state: 'unavailable', title: '摘要无法读取', message: result.error || '摘要已失效' }
      if (result.data.view !== 'entries') throw new Error('摘要返回了错误的展示类型')
      return summary(result.data.report.scopeLabel, result.data.entries.map(entry => `${entry.source.title}\n${entry.source.quote}`).join('\n\n'))
    }
    case 'conversation': {
      const scopes = await api.agent.listConversationScopes()
      if (!scopes.success || !scopes.data) throw new Error(scopes.error || '会话列表无法读取')
      const scope = scopes.data.find(scope => scope.id === ref.id)
      if (!scope) return invalid()
      const result = await api.agent.getConversationScopeMessages(ref.id)
      if (!result.success || !result.data) throw new Error(result.error || '会话无法读取')
      return summary('会话', result.data.slice(-3).map(message => message.content).join('\n\n'))
    }
    case 'fastcard': {
      const result = await api.browser.listFastCardItems()
      if (!result.success || !result.data) throw new Error(result.error || '卡片无法读取')
      const card = result.data.find(card => card.id === ref.id)
      return card ? summary(card.title || '卡片', [card.text, card.description, card.caption, card.translatedText, card.source?.pageUrl].filter(Boolean).join('\n')) : invalid()
    }
  }
}
