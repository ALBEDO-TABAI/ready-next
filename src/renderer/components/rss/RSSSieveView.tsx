import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Bookmark, BookmarkCheck, ChevronDown, Layers, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { RSSBehaviorInput, RSSSieveItem, RSSSieveResult, RSSWorkContextSnapshot, RSSWorkPrivacy } from '../../../shared/rss-sieve'
import { toReadyUri } from '../../../shared/ready-ref'
import { Button, IconButton } from '../ui/Button'
import { openFloat } from '../ui/float/float-store'
import { useFastCard } from '../../stores/useFastCard'
import type { FastCardItem } from '../../../shared/fastcard'

// 为你筛过的 (W5 §2.3, V1/V2/V6/V8): the default view of 资讯. Up to 12 recent unread articles that cleared the
// threshold, each with the one reason that contributed most; the rest folded below by time. Feedback (多看 / 少看)
// takes effect on the next ranking. The work list is never sent before the person answers the first-time question.
type Response<T> = { success: boolean; data?: T; error?: string }
const unwrap = async <T,>(request: Promise<Response<T>>): Promise<T> => {
  const result = await request
  if (!result.success || result.data === undefined) throw new Error(result.error || '资讯操作没有完成')
  return result.data
}
type Empty = 'sources' | 'model' | 'disabled' | 'limit' | 'quiet'
const EMPTY: Record<Empty, string> = {
  sources: '还没有订阅来源。到左下的“来源”里添加一个，筛子就开始工作。',
  model: '还没有配置可用的模型。筛子要靠模型判断一篇文章和你的关系。',
  disabled: '自动整理已关闭，新文章不会被判断。可以在“筛子设置”里打开。',
  limit: '今天的判断次数用完了，明天继续。“全部”里仍能看到所有新文章。',
  quiet: '最近 48 小时还没有达到门槛的新文章。',
}

function timeLabel(item: RSSSieveItem): string {
  const at = item.publishedAt ?? item.collectedAt, date = new Date(at), now = new Date()
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === now.toDateString()) return `今天 ${clock}`
  if (new Date(now.getTime() - 86400000).toDateString() === date.toDateString()) return `昨天 ${clock}`
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function RSSSieveView({ onOpen }: { onOpen(item: RSSSieveItem): void }) {
  const [result, setResult] = useState<RSSSieveResult | null>(null)
  const [empty, setEmpty] = useState<Empty>('quiet')
  const [privacy, setPrivacy] = useState<RSSWorkPrivacy | null>(null)
  const [work, setWork] = useState<RSSWorkContextSnapshot | null>(null)
  const [restOpen, setRestOpen] = useState(false)
  const [error, setError] = useState('')
  const api = window.electronAPI.rss
  const load = useCallback(async () => {
    try {
      const [sieved, sources, status, consent] = await Promise.all([unwrap(api.sieveQuery({})), unwrap(api.getSources()), unwrap(api.processingStatus()), unwrap(api.sievePrivacy())])
      setResult(sieved); setPrivacy(consent); setError('')
      setEmpty(!sources.length ? 'sources' : status.blocked === 'model' ? 'model' : status.blocked === 'disabled' ? 'disabled' : status.blocked === 'limit' ? 'limit' : 'quiet')
      // The preview lists exactly what would be sent; it is read only to show it, never sent before the answer.
      if (consent.answer === 'unanswered') setWork(await unwrap(api.sieveWorkContext()))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [api])
  useEffect(() => { void load() }, [load])
  const answer = async (enabled: boolean) => {
    try { setPrivacy(await unwrap(api.sieveConfigurePrivacy({ answer: enabled ? 'enabled' : 'later', enabled }))) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const record = async (input: Omit<RSSBehaviorInput, 'id' | 'at'>) => {
    try { await unwrap(api.sieveRecordBehavior({ ...input, id: crypto.randomUUID(), at: Date.now() } as RSSBehaviorInput)); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const items = result?.items ?? []
  return <section className="rss-sieve" aria-label="为你筛过的">
    <header className="rss-sieve__head">
      <h2>为你筛过的</h2>
      <p>最近 48 小时，按和你的关系排序{items.length ? ` · ${items.length} 篇` : ''}</p>
    </header>
    {privacy?.answer === 'unanswered' && <WorkConsent work={work} onAnswer={enabled => void answer(enabled)} />}
    {error && <p role="alert" className="rss-sieve__note">{error}</p>}
    {result && !items.length && <p className="rss-sieve__empty">{EMPTY[empty]}</p>}
    <ol className="rss-sieve__list">
      {items.map(item => <li key={item.id}><SieveCard item={item} onOpen={() => onOpen(item)} onRecord={record}
        onStar={async () => { try { await unwrap(api.toggleStarred(item.id)); await record({ itemId: item.id, action: 'star' }) } catch (cause) { setError(String(cause)) } }} /></li>)}
    </ol>
    {!!result?.remainingCount && <div className="rss-sieve__rest">
      <button type="button" className="rss-sieve__rest-toggle" aria-expanded={restOpen} onClick={() => setRestOpen(open => !open)}>
        <ChevronDown size={14} style={{ transform: restOpen ? 'none' : 'rotate(-90deg)' }} />其余 {result.remainingCount} 条
      </button>
      {restOpen && <ul className="rss-sieve__rest-list">{result.remaining.map(item => <li key={item.id}>
        <button type="button" onClick={() => onOpen(item)}><span className="rss-sieve__rest-title">{item.title}</span><span className="rss-sieve__meta">{item.source} · {timeLabel(item)}</span></button>
      </li>)}</ul>}
    </div>}
  </section>
}

function WorkConsent({ work, onAnswer }: { work: RSSWorkContextSnapshot | null; onAnswer(enabled: boolean): void }) {
  return <aside className="rss-sieve__consent" aria-label="让筛子参考你正在做的事">
    <h3>让筛子参考你正在做的事？</h3>
    <p>筛子可以参考你正在写的页面、近期的日程和在读的书，把相关的文章排在前面。这份清单只含标题，会随判断请求发给你配置的模型服务商。回答之前不会发送任何内容。</p>
    {work && (work.entries.length
      ? <ul className="rss-sieve__consent-list" aria-label="将会发送的清单">{work.entries.map((entry, index) => <li key={index}>{entry.title}</li>)}</ul>
      : <p className="rss-sieve__meta">现在没有可以参考的标题。</p>)}
    <div className="rss-sieve__consent-actions">
      <Button size="sm" variant="ghost" onClick={() => onAnswer(false)}>先不用</Button>
      <Button size="sm" variant="primary" onClick={() => onAnswer(true)}>开启</Button>
    </div>
    <p className="rss-sieve__meta">之后可以在“筛子设置”里随时改，也可以分别关掉页面、日程或书。</p>
  </aside>
}

function SieveCard({ item, onOpen, onRecord, onStar }: { item: RSSSieveItem; onOpen(): void; onRecord(input: Omit<RSSBehaviorInput, 'id' | 'at'>): Promise<void>; onStar(): Promise<void> }) {
  const topics = item.classifications.filter(entry => entry.kind === 'topic' && entry.included === true)
  const feedback = (action: 'more' | 'less', anchor: DOMRect) => openFloat({
    anchor, placement: 'bottom-end', offset: 6, role: 'menu', label: action === 'more' ? '多看这类' : '少看这类',
    render: close => <FeedbackReasons action={action} source={item.source} topics={topics} choose={(reason, topicId) => { close(); void onRecord({ itemId: item.id, action, reason, ...(topicId ? { topicId } : {}) }) }} />,
  })
  const toFastCard = () => {
    const text = item.summary || item.title
    const card: FastCardItem = { id: crypto.randomUUID(), kind: 'text', title: item.title, text, createdAt: Date.now(), tags: [],
      source: { pageUrl: toReadyUri({ kind: 'rss-item', id: item.id }), pageTitle: item.title, domain: item.source } }
    void useFastCard.getState().addItem(card).then(ok => { if (ok) void onRecord({ itemId: item.id, action: 'fastcard' }) })
  }
  return <article className="rss-sieve__card" data-sieve-item={item.id}>
    <button type="button" className="rss-sieve__title" onClick={onOpen}>{item.title}</button>
    <p className="rss-sieve__reason">{item.sieve.reason}</p>
    <div className="rss-sieve__foot">
      <span className="rss-sieve__meta">{item.source} · {timeLabel(item)}</span>
      <span className="rss-sieve__actions">
        <IconButton size="sm" icon={item.starred ? <BookmarkCheck size={14} /> : <Bookmark size={14} />} title={item.starred ? '取消收藏' : '收藏'} active={item.starred} onClick={() => void onStar()} />
        <IconButton size="sm" icon={<Layers size={14} />} title="存入 FastCard" onClick={toFastCard} />
        <IconButton size="sm" icon={<ThumbsUp size={14} />} title="多看这类" onClick={event => feedback('more', event.currentTarget.getBoundingClientRect())} />
        <IconButton size="sm" icon={<ThumbsDown size={14} />} title="少看这类" onClick={event => feedback('less', event.currentTarget.getBoundingClientRect())} />
      </span>
    </div>
  </article>
}

function FeedbackReasons({ action, source, topics, choose }: {
  action: 'more' | 'less'; source: string; topics: { definitionId: string; name: string }[]
  choose(reason: 'source' | 'topic' | 'shallow' | 'known', topicId?: string): void
}): ReactNode {
  return <div className="rn-menu" role="menu" aria-label={action === 'more' ? '多看这类：因为' : '少看这类：因为'}>
    <div className="rn-menu__group">{action === 'more' ? '多看这类，因为' : '少看这类，因为'}</div>
    <button type="button" role="menuitem" className="rn-menu__item" onClick={() => choose('source')}><span className="rn-menu__label">这个来源（{source}）</span></button>
    {topics.map(topic => <button type="button" role="menuitem" key={topic.definitionId} className="rn-menu__item" onClick={() => choose('topic', topic.definitionId)}>
      <span className="rn-menu__label">这个话题（{topic.name}）</span></button>)}
    {action === 'less' && <button type="button" role="menuitem" className="rn-menu__item" onClick={() => choose('shallow')}><span className="rn-menu__label">太浅</span></button>}
    {action === 'less' && topics[0] && <button type="button" role="menuitem" className="rn-menu__item" onClick={() => choose('known', topics[0].definitionId)}><span className="rn-menu__label">已经知道了</span></button>}
  </div>
}
