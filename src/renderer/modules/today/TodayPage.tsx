import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, Check, FilePlus, Rss } from 'lucide-react'
import { toReadyUri, type ReadyRef } from '../../../shared/ready-ref'
import { RSSCalibrationCard } from '../../components/rss/RSSCalibrationCard'
import { Button } from '../../components/ui/Button'
import { Skeleton } from '../../components/ui/Display'
import { RefCapsule } from '../../components/ui/RefCapsule'
import { showToast } from '../../components/ui/toast-store'
import { useDocTabs } from '../../stores/useDocTabs'
import { useFastCard } from '../../stores/useFastCard'
import { useRSSSession } from '../../stores/useRSSSession'
import { todoFromList, toggleTodo } from '../calendar/workbench/layers/todo-actions'
import { requestShellAction } from '../workbench/commands/shell-actions'
import { requestWorkbenchModeOpen } from '../workbench/mode-transition'
import { queryToday, type TodayFirstScreen, type TodaySieve } from './data'
import { dateLine, editedText, eventTime, fileTitle, greetingText, overdueText, progressText, visibleBlocks } from './today-format'

type Todo = TodayFirstScreen['upcoming']['todos'][number]
const REFRESH_MS = 60_000
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** The first screen and 为你筛过的 load separately (§5.2): the local snapshot is on screen at once, 资讯 follows. */
function useToday(visible: boolean) {
  const [first, setFirst] = useState<TodayFirstScreen | null>(null)
  const [sieve, setSieve] = useState<TodaySieve | 'loading' | null>('loading')
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const generation = useRef(0)
  const requestedAt = useRef<number | null>(null)
  const load = useCallback(() => {
    const id = ++generation.current
    requestedAt.current ??= performance.now()
    setNow(Date.now())
    const { firstScreen, sieve: sieved } = queryToday()
    firstScreen.then(data => { if (id === generation.current) { setFirst(data); setError('') } },
      cause => { if (id === generation.current) setError(message(cause)) })
    sieved.then(data => { if (id === generation.current) setSieve(data) }, cause => {
      if (id !== generation.current) return
      console.warn('[today] 为你筛过的 could not be read', cause)
      setSieve(null)
    })
  }, [])
  useEffect(() => {
    if (!visible) return
    load()
    // Remaining events and countdowns move with the clock; to-dos and the shelf change from other places.
    const timer = window.setInterval(load, REFRESH_MS)
    const offTodos = window.electronAPI.calendarLayers?.onChanged(load)
    const offShelf = useFastCard.subscribe((state, previous) => { if (state.items !== previous.items) load() })
    window.addEventListener('focus', load)
    return () => { window.clearInterval(timer); offTodos?.(); offShelf(); window.removeEventListener('focus', load) }
  }, [visible, load])
  return { first, sieve, error, now, load, requestedAt }
}

/**
 * 今日 (W6 §5): what the four kinds of information hold for this moment, on one paper. Six blocks — the greeting,
 * 接下来, 为你筛过的, 继续, 收集, 涌现 — each only reading existing services (K6). A block with nothing to show leaves no
 * title or shell behind; a page with nothing at all shows how to start. Every row is a reference capsule: click opens,
 * ⌥-click or hover-then-Space quick-looks, dragging carries it.
 */
export function TodayPage({ visible }: { visible: boolean }) {
  const { first, sieve, error, now, load, requestedAt } = useToday(visible)
  const root = useRef<HTMLElement>(null)
  // The first-screen time (§5.2: within 150 ms) from the request to the frame that shows it; the window check reads it.
  useLayoutEffect(() => {
    const element = root.current
    if (!first || !element || element.dataset.firstScreenMs || requestedAt.current === null) return
    element.dataset.firstScreenMs = String(Math.round(performance.now() - requestedAt.current))
  }, [first, requestedAt])
  // To-dos ticked here stay in the list, ticked, until 今日 is opened again.
  const [done, setDone] = useState<Todo[]>([])
  const check = (todo: Todo) => {
    setDone(current => [...current, todo])
    void toggleTodo(todoFromList(todo.todo), true).then(state => {
      if (state === 'unsaved') showToast('已在打开的页面里勾掉，保存那一页后生效')
    }, cause => {
      setDone(current => current.filter(item => item.todo.id !== todo.todo.id))
      showToast(message(cause), { tone: 'bad' })
    }).finally(load)
  }
  if (!first) return <section ref={root} className="today" aria-label="今日" data-today-page="loading">
    {error && <div className="today-column"><ErrorLine error={error} retry={load} /></div>}
  </section>
  const blocks = visibleBlocks(first, sieve)
  const todos = [...first.upcoming.todos, ...done.filter(item => !first.upcoming.todos.some(todo => todo.todo.id === item.todo.id))]
  const upcoming = (blocks.includes('upcoming') || done.length > 0) && <Block name="upcoming" label="接下来">
    {first.upcoming.events.length > 0 && <ul className="today-list">{first.upcoming.events.map(event => {
      const time = eventTime(event, first.upcoming.nextStart, now)
      return <Row key={`${toReadyUri(event.ref)}@${event.start}`} item={event} plain lead={<span className={`today-time${time.now ? ' is-now' : ''}`}>{time.text}</span>} />
    })}</ul>}
    {todos.length > 0 && <ul className="today-list">{todos.map(todo => {
      const ticked = done.some(item => item.todo.id === todo.todo.id), late = overdueText(todo.todo.date, first.greeting.date)
      return <Row key={todo.todo.id} item={todo} plain className={ticked ? 'is-done' : undefined} data={{ 'data-todo-id': todo.todo.id }}
        lead={<button type="button" role="checkbox" aria-checked={ticked} disabled={ticked} className="rn-check__box today-check" aria-label={`勾掉：${todo.title}`}
          onClick={() => check(todo)}><Check aria-hidden /></button>}
        meta={`${late ? `${late} · ` : ''}${todo.todo.page.title}`} />
    })}</ul>}
  </Block>
  const { pages, books, drafts } = first.continue
  const resume = blocks.includes('continue') && <Block name="continue" label="继续">
    <ul className="today-list">
      {pages.map(page => <Row key={toReadyUri(page.ref)} item={page} meta={editedText(page.editedAt, now)} />)}
      {books.map(book => <Row key={toReadyUri(book.ref)} item={book} meta={progressText(book.progress)} />)}
      {drafts.map(draft => <Row key={toReadyUri(draft.ref)} item={draft} meta="未保存" />)}
    </ul>
  </Block>
  const collection = blocks.includes('collection') && <Block name="collection" label="收集"
    aside={<><span>共 {first.collection.total} 条</span><button type="button" className="today-link" onClick={() => { void useFastCard.getState().open() }}>整理到画板</button></>}>
    <ul className="today-list">{first.collection.items.map(item => <Row key={toReadyUri(item.ref)} item={item} />)}</ul>
  </Block>
  const emergence = blocks.includes('emergence') && <Block name="emergence" label="涌现">
    <ul className="today-list">{first.emergence.map(file => <Row key={toReadyUri(file.ref)} item={file} title={fileTitle(file.title)} hint={file.title} meta={file.reason} />)}</ul>
  </Block>
  return <section ref={root} className="today" aria-label="今日" data-today-page="ready">
    <div className="today-column">
      <header className="today-hello">
        <h1>{greetingText(first.greeting.period)}</h1>
        <p>{dateLine(first.greeting.date)}</p>
      </header>
      {(upcoming || resume) && <div className="today-pair">{upcoming}{resume}</div>}
      {blocks.includes('sieve') && <Block name="sieve" label="为你筛过的"
        aside={<button type="button" className="today-link" onClick={() => { useRSSSession.getState().setSieveView(true); requestWorkbenchModeOpen('rss') }}>查看全部</button>}>
        {sieve === 'loading' ? <ul className="today-list" aria-busy="true" aria-label="正在读取资讯">
          {[72, 58, 64].map(width => <li key={width} className="today-row"><Skeleton height={13} width={`${width}%`} /></li>)}
        </ul> : <>
          {/* The weekly 筛子校准 proposal sits above the picks while it waits for an answer (W5 §2.4). */}
          {sieve?.calibration && <RSSCalibrationCard active={visible} onSettled={load} />}
          {sieve && sieve.articles.length > 0 && <ul className="today-list">{sieve.articles.map(article => <Row key={toReadyUri(article.ref)} item={article} plain meta={article.reason} />)}</ul>}
        </>}
      </Block>}
      {(collection || emergence) && <div className="today-pair">{collection}{emergence}</div>}
      {!blocks.length && !done.length && <Guide />}
      {error && <ErrorLine error={error} retry={load} />}
    </div>
  </section>
}

function Block({ name, label, aside, children }: { name: string; label: string; aside?: ReactNode; children: ReactNode }) {
  return <section className="today-block" aria-label={label} data-today-block={name}>
    <div className="today-label"><h2>{label}</h2>{aside && <div className="today-label__aside">{aside}</div>}</div>
    {children}
  </section>
}

function Row({ item, title, hint, lead, meta, plain, className, data }: {
  item: { ref: ReadyRef; title: string }; title?: string; hint?: string; lead?: ReactNode; meta?: ReactNode
  /** Rows led by a time or a checkbox show no type icon. */ plain?: boolean
  className?: string; data?: Record<`data-${string}`, string>
}) {
  return <li className={className ? `today-row ${className}` : 'today-row'} {...data}>
    {lead}
    <RefCapsule reference={item.ref} title={title ?? item.title} typeHint={hint} className={plain ? 'today-ref is-plain' : 'today-ref'} />
    {meta ? <span className="today-row__meta">{meta}</span> : null}
  </li>
}

/** A page with nothing on it yet (§5.2): three ways to start, each opening where it is done. */
function Guide() {
  return <section className="today-guide" aria-label="从这里开始">
    <p>今天这一页还是空的。它会把今天的日程与待办、为你筛过的资讯、在读的书和没写完的页面放在一起。先放一点东西进来：</p>
    <div className="today-guide__actions">
      <Button size="sm" icon={<Rss />} onClick={() => { useRSSSession.getState().requestAddSource(true); requestWorkbenchModeOpen('rss') }}>添加订阅源</Button>
      <Button size="sm" icon={<FilePlus />} onClick={() => requestShellAction('new-page')}>新建第一页</Button>
      <Button size="sm" icon={<BookOpen />} onClick={() => { useDocTabs.getState().openLibraryTab(); requestWorkbenchModeOpen('document') }}>导入一本书</Button>
    </div>
  </section>
}

function ErrorLine({ error, retry }: { error: string; retry(): void }) {
  return <p role="alert" className="today-error">今日没有读出来：{error}<button type="button" className="today-link" onClick={retry}>再试一次</button></p>
}
