import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Bookmark, BookmarkCheck, ChevronDown, Layers, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { RSSBehaviorInput, RSSSieveItem, RSSSieveResult, RSSWorkContextSnapshot, RSSWorkPrivacy } from '../../../shared/rss-sieve'
import type { FastCardItem } from '../../../shared/fastcard'
import { toReadyUri } from '../../../shared/ready-ref'
import { Button, IconButton } from '../ui/Button'
import { openFloat } from '../ui/float/float-store'
import { useFastCard } from '../../stores/useFastCard'
import { recordRSSBehavior } from '../../modules/rss/record-behavior'
import { unwrapRSS } from '../../modules/rss/unwrap'
import RSSTopbarTools from './RSSTopbarTools'
import { RSSCalibrationCard } from './RSSCalibrationCard'

// 为你筛过的 (W5 §2.3, V1/V2/V6/V8): where 资讯 opens. Up to 12 recent unread articles that cleared the threshold, each
// with the one reason that contributed most; the rest folded below by time. 多看 / 少看 take effect on the next ranking,
// so the list reloads right after. Articles judged while the list is on screen do not reorder it under the reader:
// they wait behind a quiet 有新结果 button. The work list is never sent before the first-time question is answered.
type Empty = 'sources' | 'model' | 'disabled' | 'limit' | 'quiet'
const EMPTY: Record<Empty, string> = {
  sources: '还没有订阅来源。从左下的“来源”添加一个，筛子就开始工作。',
  model: '还没有配置可用的模型。筛子要靠模型判断一篇文章和你的关系。',
  disabled: '自动整理已关闭，新文章不会被判断。可以在“筛子设置”里打开。',
  limit: '今天的判断次数用完了，明天继续。“全部”里仍能看到所有新文章。',
  quiet: '最近 48 小时还没有达到门槛的新文章。',
}
type Feedback = (input: Omit<RSSBehaviorInput, 'id' | 'at'>) => Promise<void>

function timeLabel(item: RSSSieveItem): string {
  const at = item.publishedAt ?? item.collectedAt, date = new Date(at), now = new Date()
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === now.toDateString()) return `今天 ${clock}`
  if (new Date(now.getTime() - 86400000).toDateString() === date.toDateString()) return `昨天 ${clock}`
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function RSSSieveView({ shown, onOpen }: { shown: boolean; onOpen(item: RSSSieveItem): void }) {
  const [result, setResult] = useState<RSSSieveResult | null>(null)
  const [empty, setEmpty] = useState<Empty>('quiet')
  const [privacy, setPrivacy] = useState<RSSWorkPrivacy | null>(null)
  const [work, setWork] = useState<RSSWorkContextSnapshot | null>(null)
  const [restOpen, setRestOpen] = useState(false)
  const [updates, setUpdates] = useState(false)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState('')
  const scroller = useRef<HTMLElement>(null)
  const scrollTop = useRef(0)
  const hasItems = useRef(false)
  const ticket = useRef(0)
  const load = useCallback(async () => {
    const mine = ++ticket.current
    try {
      const api = window.electronAPI.rss
      const [sieved, sources, status, consent] = await Promise.all([unwrapRSS(api.sieveQuery({})), unwrapRSS(api.getSources()), unwrapRSS(api.processingStatus()), unwrapRSS(api.sievePrivacy())])
      // The preview lists exactly what would be sent; it is read only to show it, never sent before the answer.
      const preview = consent.answer === 'unanswered' ? await unwrapRSS(api.sieveWorkContext()) : null
      if (mine !== ticket.current) return
      setResult(sieved); setPrivacy(consent); setWork(preview); setUpdates(false); setError('')
      hasItems.current = sieved.items.some(item => !item.sieve.explore)
      setEmpty(!sources.length ? 'sources' : status.blocked === 'model' ? 'model' : status.blocked === 'disabled' ? 'disabled' : status.blocked === 'limit' ? 'limit' : 'quiet')
    } catch (cause) { if (mine === ticket.current) setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [])
  useEffect(() => {
    void load()
    return window.electronAPI.rss.onOrganizationChanged(() => { if (hasItems.current) setUpdates(true); else void load() })
  }, [load])
  // Hidden while an article from this list is open: the scroll position is kept by hand, since display:none drops it.
  useLayoutEffect(() => { if (shown && scroller.current) scroller.current.scrollTop = scrollTop.current }, [shown])
  const answer = async (enabled: boolean) => {
    try { setPrivacy(await unwrapRSS(window.electronAPI.rss.sieveConfigurePrivacy({ answer: enabled ? 'enabled' : 'later', enabled }))) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const feedback: Feedback = async (input) => {
    try { await recordRSSBehavior(input); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const open = (item: RSSSieveItem) => { setOpened(previous => new Set(previous).add(item.id)); onOpen(item) }
  const items = result?.items ?? []
  // The daily 换换口味 pick rides along below the ranked list; on its own it is no answer to “why is this empty”.
  const ranked = items.filter(item => !item.sieve.explore)
  return <section ref={scroller} className="rss-sieve" aria-label="为你筛过的" style={{ display: shown ? undefined : 'none' }}
    onScroll={event => { scrollTop.current = event.currentTarget.scrollTop }}>
    <RSSTopbarTools slot="lead" show={shown}><span>为你筛过的</span></RSSTopbarTools>
    <div className="rss-sieve__inner">
      <header className="rss-sieve__head">
        <h1>为你筛过的</h1>
        <p>最近 48 小时，按和你的关系排序{ranked.length ? ` · ${ranked.length} 篇` : ''}</p>
        {updates && <button type="button" className="rss-sieve__updates" onClick={() => void load()}>有新结果，刷新</button>}
      </header>
      {privacy?.answer === 'unanswered' && <WorkConsent work={work} onAnswer={enabled => void answer(enabled)} />}
      <RSSCalibrationCard active={shown} />
      {error && <p role="alert" className="rss-sieve__error">{error}</p>}
      {result && !ranked.length && <p className="rss-sieve__empty">{EMPTY[empty]}</p>}
      <ol className="rss-sieve__list">
        {items.map(item => <li key={item.id}>
          <SieveCard item={item} opened={opened.has(item.id) || item.read} onOpen={() => open(item)} onFeedback={feedback} onError={setError} />
        </li>)}
      </ol>
      {!!result?.remainingCount && <div className="rss-sieve__rest">
        <button type="button" className="rss-sieve__rest-toggle" aria-expanded={restOpen} onClick={() => setRestOpen(value => !value)}>
          <ChevronDown size={14} strokeWidth={1.9} className="rss-sieve__chevron" />其余 {result.remainingCount} 条
        </button>
        {restOpen && <ul className="rss-sieve__rest-list">{result.remaining.map(item => <li key={item.id}>
          <button type="button" data-opened={opened.has(item.id) || item.read || undefined} onClick={() => open(item)}>
            <span className="rss-sieve__rest-title">{item.title}</span>
            <span className="rss-sieve__meta">{item.source} · {timeLabel(item)}</span>
          </button>
        </li>)}</ul>}
      </div>}
    </div>
  </section>
}

function WorkConsent({ work, onAnswer }: { work: RSSWorkContextSnapshot | null; onAnswer(enabled: boolean): void }) {
  return <aside className="rss-sieve__consent" aria-label="让筛子参考你正在做的事">
    <h2>让筛子参考你正在做的事？</h2>
    <p>筛子可以参考你在写的页面、近期的日程和在读的书，把相关的文章排到前面。下面这份清单只含标题，会随判断请求发给你配置的模型服务商。回答之前，一个字也不会发出去。</p>
    {work && (work.entries.length
      ? <ul className="rss-sieve__consent-list" aria-label="将会发送的清单">{work.entries.map((entry, index) => <li key={index}>{entry.title}</li>)}</ul>
      : <p className="rss-sieve__meta">现在没有可以参考的标题。</p>)}
    <div className="rss-sieve__consent-actions">
      <span className="rss-sieve__meta">之后可以在“筛子设置”里随时改，也能分别关掉页面、日程或书。</span>
      <Button size="sm" variant="ghost" onClick={() => onAnswer(false)}>先不用</Button>
      <Button size="sm" variant="primary" onClick={() => onAnswer(true)}>开启</Button>
    </div>
  </aside>
}

function SieveCard({ item, opened, onOpen, onFeedback, onError }: {
  item: RSSSieveItem; opened: boolean; onOpen(): void; onFeedback: Feedback; onError(message: string): void
}) {
  const [starred, setStarred] = useState(item.starred)
  useEffect(() => setStarred(item.starred), [item.starred])
  const topics = item.classifications.filter(entry => entry.kind === 'topic' && entry.included === true)
  const ask = (action: 'more' | 'less', anchor: HTMLElement) => openFloat({
    anchor: anchor.getBoundingClientRect(), placement: 'bottom-end', offset: 6, role: 'menu', label: action === 'more' ? '多看这类' : '少看这类',
    render: close => <FeedbackReasons action={action} source={item.source} topics={topics}
      choose={(reason, topicId) => { close(); void onFeedback({ itemId: item.id, action, reason, ...(topicId ? { topicId } : {}) }) }} />,
  })
  const star = async () => {
    try {
      const result = await window.electronAPI.rss.toggleStarred(item.id)
      if (!result.success) throw new Error(result.error || '收藏没有保存')
      const next = !starred
      setStarred(next)
      if (next) await recordRSSBehavior({ itemId: item.id, action: 'star' })
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const keep = async () => {
    const card: FastCardItem = { id: crypto.randomUUID(), kind: 'text', title: item.title, text: item.summary || item.title, createdAt: Date.now(), tags: [],
      source: { pageUrl: toReadyUri({ kind: 'rss-item', id: item.id }), pageTitle: item.title, domain: item.source } }
    try {
      if (!await useFastCard.getState().addItem(card)) throw new Error('没有存入 FastCard')
      await recordRSSBehavior({ itemId: item.id, action: 'fastcard' })
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <article className="rss-sieve__card" data-sieve-item={item.id} data-opened={opened || undefined} data-explore={item.sieve.explore || undefined}>
    <button type="button" className="rss-sieve__title" onClick={onOpen}>{item.title}</button>
    <p className="rss-sieve__reason">{item.sieve.reason}</p>
    <div className="rss-sieve__foot">
      <span className="rss-sieve__meta">{item.source} · {timeLabel(item)}</span>
      <span className="rss-sieve__actions">
        <IconButton size="sm" icon={starred ? <BookmarkCheck size={15} /> : <Bookmark size={15} />} title={starred ? '取消收藏' : '收藏'} active={starred} onClick={() => void star()} />
        <IconButton size="sm" icon={<Layers size={15} />} title="存入 FastCard" onClick={() => void keep()} />
        <IconButton size="sm" icon={<ThumbsUp size={15} />} title="多看这类" onClick={event => ask('more', event.currentTarget)} />
        <IconButton size="sm" icon={<ThumbsDown size={15} />} title="少看这类" onClick={event => ask('less', event.currentTarget)} />
      </span>
    </div>
  </article>
}

function FeedbackReasons({ action, source, topics, choose }: {
  action: 'more' | 'less'; source: string; topics: { definitionId: string; name: string }[]
  choose(reason: 'source' | 'topic' | 'shallow' | 'known', topicId?: string): void
}): ReactNode {
  const item = (key: string, label: string, run: () => void) =>
    <button type="button" role="menuitem" key={key} className="rn-menu__item" onClick={run}><span className="rn-menu__label">{label}</span></button>
  return <div className="rn-menu" role="menu" aria-label={action === 'more' ? '多看这类，因为' : '少看这类，因为'}>
    <div className="rn-menu__group">{action === 'more' ? '多看这类，因为' : '少看这类，因为'}</div>
    {item('source', `这个来源：${source}`, () => choose('source'))}
    {topics.map(topic => item(topic.definitionId, `这个话题：${topic.name}`, () => choose('topic', topic.definitionId)))}
    {action === 'less' && item('shallow', '太浅', () => choose('shallow'))}
    {action === 'less' && topics[0] && item('known', '已经知道了', () => choose('known', topics[0].definitionId))}
  </div>
}
