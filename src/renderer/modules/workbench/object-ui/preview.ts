import type { StoredObjectPreview, DatabasePreview } from '../../../../shared/object-preview'
import type { DaySummary } from '../../../../shared/calendar-linkage'
import type { FastCardItem } from '../../../../shared/fastcard'
import type { RSSArticleSummary } from '../../../../shared/rss-workspace'
import type { RSSRelevance } from '../../../../shared/rss-sieve'
import { readDocumentSource } from '../../../../shared/document-operations'
import { conversationTurn } from '../../../../shared/conversation-preview'
import { ReadyRefSchema, type ReadyRef } from '../../../../shared/ready-ref'
import { useDocTabs } from '../../../stores/useDocTabs'
import { findCalendarOccurrence } from '../../../../shared/calendar/commands'

type DocumentRead = Awaited<ReturnType<Window['electronAPI']['document']['readFile']>>
export type ObjectPreviewData = StoredObjectPreview | DatabasePreview
  | { kind: 'file'; file: Extract<DocumentRead['data'], { type: 'binary' }> }
  | { kind: 'day'; summary: DaySummary }
  | { kind: 'event'; event: import('../../../../shared/calendar/model').CalEvent; start: number; end: number }
  | { kind: 'rss-digest'; report: import('../../../../shared/rss-digests').RSSDigestHeader; entries: import('../../../../shared/rss-digests').RSSDigestEntry[] }
  | { kind: 'rss-item'; article: Pick<RSSArticleSummary, 'id' | 'title' | 'source' | 'link'> & { summary?: string }; relevance: RSSRelevance | null; excerpt?: string }
  | { kind: 'rss-query'; total: number; items: RSSArticleSummary[] }
  | { kind: 'conversation'; scopeId: string; run?: string; messageId: string; question: string; answer: string }
  | { kind: 'fastcard'; card: FastCardItem }
export type ObjectPreview =
  | { state: 'ready'; title: string; body: string; markdown: boolean; unsaved: boolean; data?: ObjectPreviewData }
  | { state: 'invalid' | 'unavailable'; title: string; message: string }
const invalid = (): ObjectPreview => ({ state: 'invalid', title: '引用已失效', message: '对象已删除、移入回收站或不再可用' })
const summary = (title: string, body: string, data?: ObjectPreviewData): ObjectPreview => ({ state: 'ready', title, body, markdown: false, unsaved: false, ...(data ? { data } : {}) })

/** Read current owners; this read-only surface never saves or hydrates a tab. */
export async function loadObjectPreview(input: ReadyRef): Promise<ObjectPreview> {
  const ref = ReadyRefSchema.parse(input), api = window.electronAPI
  switch (ref.kind) {
    case 'rss-calibration': {
      const result = await api.rss.sieveCalibration()
      if (!result.success) throw new Error(result.error)
      return result.data?.week === ref.id ? summary('筛子校准', [result.data.text, result.data.explanation].filter(Boolean).join('\n')) : invalid()
    }
    case 'draft': {
      const result = await api.documentDrafts.read(ref.id)
      if (!result.ok) throw new Error(result.message)
      if (!result.value) return invalid()
      const tab = useDocTabs.getState().tabs.find(tab => tab.draftId === ref.id)
      return { state: 'ready', title: result.value.title || '未保存的草稿', body: tab?.content ?? result.value.content, markdown: true, unsaved: true }
    }

    case 'page': case 'file': case 'canvas': {
      const location = await api.objects.locate(ref.id)
      if (!location) return invalid()
      const title = (location.path.split(/[\\/]/).pop() || ref.id).replace(/\.[^.]+$/, '')
      const tab = useDocTabs.getState().tabs.find(tab => tab.objectId === ref.id || tab.path === location.path)
      if (tab?.isDirty) return { state: 'ready', title: tab.title, body: tab.content, markdown: ref.kind === 'page', unsaved: true }
      if (ref.kind === 'canvas' || ref.kind === 'page' && ref.anchor?.startsWith('^hl-')) {
        const data = await api.objects.preview(ref)
        if (data?.kind === 'canvas') return summary(data.title, data.nodes.map(node => node.title).join('\n'), data)
        if (data?.kind === 'book') return summary(data.book.title, data.passage?.text || data.book.author, data)
        if (ref.kind === 'canvas') return invalid()
      }
      const result = await api.document.readFile(location.path)
      if (!result.success) throw new Error(result.error || '读取失败')
      const body = result.data?.type === 'text' ? result.data.content : result.content
      if (typeof body === 'string' && ref.kind === 'page' && readDocumentSource(body).frontmatter.ready_database) {
        const data = await api.databasePreview(ref.id)
        return summary(title, data.rows.map(row => row.title).join('\n'), data)
      }
      if (typeof body === 'string') return { state: 'ready', title, body, markdown: ref.kind === 'page', unsaved: false }
      if (result.data?.type === 'binary') return summary(title, result.data.extension.toUpperCase(), { kind: 'file', file: result.data })
      throw new Error('未收到文件内容')
    }
    case 'web': {
      const data = await api.objects.preview(ref)
      return data?.kind === 'web' ? summary(data.title, [data.url, ...data.excerpts.map(excerpt => excerpt.text)].join('\n'), data) : invalid()
    }
    case 'day': {
      const day = await api.calendarLinkage.day({ date: ref.date, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      return summary(ref.date, day.items.map(item => [item.title, item.detail].filter(Boolean).join(' · ')).join('\n') || '这一天暂无记录', { kind: 'day', summary: day })
    }
    case 'book-location': {
      const data = await api.objects.preview(ref)
      return data?.kind === 'book' ? summary(data.book.title, [data.book.author, data.passage?.text].filter(Boolean).join('\n'), data) : invalid()
    }
    case 'event': {
      const result = await api.calendar.snapshot()
      if (!result.success || !result.data) throw new Error(result.error || '读取日程失败')
      const occurrence = findCalendarOccurrence(result.data.events, ref.occurrence === undefined ? ref.id : `${ref.id}|${ref.occurrence}`)
      const event = occurrence?.event
      return event ? summary(event.title, [event.description, event.location, String(occurrence.start)].filter(Boolean).join('\n'), { kind: 'event', event, start: occurrence.start, end: occurrence.end }) : invalid()
    }
    case 'rss-item': {
      if (ref.excerpt) {
        const result = await api.rss.readExcerpt({ ...ref.excerpt, itemId: ref.id })
        if (!result.success || !result.data) return { state: 'invalid', title: '引用已失效', message: result.error || '文章片段已变化或删除' }
        const scores = await api.rss.sieveRelevance(ref.id)
        if (!scores.success) throw new Error(scores.error)
        return summary(result.data.article.title, result.data.text, { kind: 'rss-item', article: result.data.article, excerpt: result.data.text, relevance: scores.data })
      }
      const result = await api.rss.readArticle({ itemId: ref.id, ...(ref.article ?? {}), length: 1200 })
      if (!result.success || !result.data) return { state: result.error === 'article_not_found' ? 'invalid' : 'unavailable', title: '文章无法读取', message: result.error === 'article_not_found' ? '文章已失效或删除' : result.error || '文章无法读取' }
      const scores = await api.rss.sieveRelevance(ref.id)
      if (!scores.success) throw new Error(scores.error)
      return summary(result.data.article.title, result.data.article.summary || result.data.article.link, { kind: 'rss-item', article: result.data.article, relevance: scores.data })
    }
    case 'rss-query': {
      const result = await api.rss.queryItems(ref.query)
      if (!result.success || !result.data) throw new Error(result.error || 'RSS 查询失败')
      return summary('RSS 查询', `${result.data.total} 篇文章\n${result.data.items.map(item => item.title).join('\n')}`, { kind: 'rss-query', total: result.data.total, items: result.data.items })
    }
    case 'rss-digest': {
      const result = await api.rss.readDigests({ view: 'entries', reportId: ref.id, offset: ref.offset, limit: ref.limit })
      if (!result.success || !result.data) return { state: 'unavailable', title: '摘要无法读取', message: result.error || '摘要已失效' }
      if (result.data.view !== 'entries') throw new Error('摘要返回了错误的展示类型')
      return summary(result.data.report.scopeLabel, result.data.entries.map(entry => `${entry.source.title}\n${entry.source.quote}`).join('\n\n'), { kind: 'rss-digest', report: result.data.report, entries: result.data.entries })
    }
    case 'conversation': {
      const scopes = await api.agent.listConversationScopes()
      if (!scopes.success || !scopes.data) throw new Error(scopes.error || '会话列表无法读取')
      const scope = scopes.data.find(scope => scope.id === ref.id)
      if (!scope) return invalid()
      const result = await api.agent.getConversationScopeMessages(ref.id)
      if (!result.success || !result.data) throw new Error(result.error || '会话无法读取')
      const turn = conversationTurn(result.data, ref.run)
      return summary(scope.title || '对话', [turn.question, turn.answer].join('\n\n'), { kind: 'conversation', scopeId: ref.id, run: ref.run, ...turn })
    }
    case 'fastcard': {
      const result = await api.browser.listFastCardItems()
      if (!result.success || !result.data) throw new Error(result.error || '卡片无法读取')
      const card = result.data.find(card => card.id === ref.id)
      return card ? summary(card.title || '卡片', [card.text, card.description, card.caption, card.translatedText, card.source?.pageUrl].filter(Boolean).join('\n'), { kind: 'fastcard', card }) : invalid()
    }
  }
}
