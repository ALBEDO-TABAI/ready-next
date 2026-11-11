import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ReactNode } from 'react'
import type { BookPreview, CanvasPreview, DatabasePreview, WebPreview } from '../../../../shared/object-preview'
import type { RSSRelevance } from '../../../../shared/rss-sieve'
import { ReadyRefSchema } from '../../../../shared/ready-ref'
import { RefCapsule } from '../../../components/ui/RefCapsule'
import { itemPreview, sourceLabel, sourceReference, timeLabel } from '../../../components/browser/fastcard-presentation'
import { cellText, dateText } from '../../document/database/cell-text'
import { DAY_ITEM_LABELS } from '../../calendar/linkage/ThisDay'
import { toLocalFileUrl } from '../../../utils/dragDrop'
import type { ObjectPreview, ObjectPreviewData } from './preview'
import type { PreviewTarget } from './navigation'

// What a quick look shows (W6 §2.2): the object's content, never its path — the first rows of a database, a board's
// cards, the passage of a book, an article and why the sieve kept it, the day, the saved excerpts, the turn, the card.

type Of<K extends ObjectPreviewData['kind']> = Extract<ObjectPreviewData, { kind: K }>
const Note = ({ children }: { children: ReactNode }) => <p className="rn-ql-note">{children}</p>

/** A cell as the table shows it: dates in the local form, errors and incomplete values spelled out. */
const cell = (type: string | undefined, value: DatabasePreview['rows'][number]['cells'][string] | undefined) =>
  type === 'date' && value?.status === 'value' && typeof value.value === 'string' ? dateText(value.value) : cellText(value)

function DatabaseLook({ data }: { data: DatabasePreview }) {
  const fields = Object.values(data.definition?.fields ?? {})
  const columns = (data.view?.visibleFields ?? ['$title', ...fields.map(field => field.id)]).slice(0, 4)
    .map(id => { const field = fields.find(field => field.id === id); return { id, name: id === '$title' ? '标题' : field?.name ?? id, type: field?.type } })
  if (!data.rows.length) return <Note>数据库还没有行</Note>
  return <>
    <div className="rn-ql-table"><table>
      <thead><tr>{columns.map(column => <th key={column.id} scope="col">{column.name}</th>)}</tr></thead>
      <tbody>{data.rows.map(row => <tr key={row.id}>
        {columns.map(column => <td key={column.id}>{column.id === '$title' ? row.title || '未命名' : cell(column.type, row.cells?.[column.id])}</td>)}
      </tr>)}</tbody>
    </table></div>
    <Note>{data.total > data.rows.length ? `前 ${data.rows.length} 行，共 ${data.total} 行` : `共 ${data.total} 行`}{data.view?.name ? ` · ${data.view.name}视图` : ''}</Note>
  </>
}

/** A card's first line as it reads on the board: no heading, list or quote marker, a web address without its scheme. */
const cardLabel = (title: string) => title.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/, '').replace(/^https?:\/\//, '')

/** The board in miniature: every card at its place and size, in the board's proportions (kept between 6:5 and 13:5). */
function CanvasLook({ data }: { data: CanvasPreview }) {
  const nodes = data.nodes.map(node => ({ ...node, x: node.x || 0, y: node.y || 0, width: node.width || 240, height: node.height || 120 }))
  if (!nodes.length) return <Note>画板上还没有卡片</Note>
  let left = Math.min(...nodes.map(node => node.x)), top = Math.min(...nodes.map(node => node.y))
  let width = Math.max(...nodes.map(node => node.x + node.width)) - left, height = Math.max(...nodes.map(node => node.y + node.height)) - top
  const aspect = Math.min(2.6, Math.max(1.2, width / height))
  if (width / height < aspect) { left -= (height * aspect - width) / 2; width = height * aspect }
  else { top -= (width / aspect - height) / 2; height = width / aspect }
  const padX = width * .04, padY = height * .04
  left -= padX; top -= padY; width += padX * 2; height += padY * 2
  const at = (value: number, from: number, size: number) => `${(value - from) / size * 100}%`
  return <>
    <div className="rn-ql-board" style={{ aspectRatio: String(width / height), width: `min(100%, ${Math.round(320 * width / height)}px)` }} role="img" aria-label={`画板缩略图：${nodes.length} 张卡片`}>
      {nodes.map((node, index) => <div key={node.id ?? index} className="rn-ql-board__card"
        style={{ left: at(node.x, left, width), top: at(node.y, top, height), width: at(node.width, 0, width), height: at(node.height, 0, height) }}>
        {node.title && <span>{cardLabel(node.title)}</span>}
      </div>)}
    </div>
    <Note>{nodes.length} 张卡片</Note>
  </>
}

const CONTEXT = 60
/** A book, and for a passage or highlight its text with a little of what comes before and after. The book's own entry
 *  (c0:0+1, what search and 打开 use) is the book itself, not a one-character passage. */
function BookLook({ data, entry }: { data: BookPreview; entry: boolean }) {
  const { book } = data
  const passage = entry ? null : data.passage
  const before = passage?.located && passage.prefix ? (passage.prefix.length > CONTEXT ? `…${passage.prefix.slice(-CONTEXT)}` : passage.prefix) : ''
  const after = passage?.located && passage.suffix ? (passage.suffix.length > CONTEXT ? `${passage.suffix.slice(0, CONTEXT)}…` : passage.suffix) : ''
  return <>
    <div className="rn-ql-book">
      <div className="rn-ql-book__cover" aria-hidden>{book.coverPath ? <img src={toLocalFileUrl(book.coverPath)} alt="" /> : <span>{book.title}</span>}</div>
      <div className="rn-ql-book__meta">
        <div className="rn-ql-book__title">{book.title}</div>
        {book.author && <div className="rn-ql-book__author">{book.author}</div>}
        {passage?.chapterTitle && <div className="rn-ql-book__chapter">{passage.chapterTitle}</div>}
      </div>
    </div>
    {passage && <blockquote className="rn-ql-passage">
      {before && <span className="rn-ql-passage__context">{before}</span>}
      <mark>{passage.text}</mark>
      {after && <span className="rn-ql-passage__context">{after}</span>}
    </blockquote>}
    {passage?.note && <p className="rn-ql-annotation">{passage.note}</p>}
    {passage && !passage.located && <Note>原文已变化，找不到这段的位置，只显示划线本身</Note>}
  </>
}

const BECAUSE = { standard: '基础标准', interest: '你的关注', work: '你在做的事' } as const
const reasonLabel = (relevance: RSSRelevance) => relevance.because === 'work' && relevance.workRef ? `你在做的《${relevance.workRef}》` : BECAUSE[relevance.because]

function ArticleLook({ data }: { data: Of<'rss-item'> }) {
  const { article, relevance, excerpt } = data
  const site = article.link ? ReadyRefSchema.safeParse({ kind: 'web', url: article.link }).data : undefined
  return <>
    {article.source && <p className="rn-ql-meta">{site ? <RefCapsule reference={site} title={article.source} /> : article.source}</p>}
    {excerpt ? <blockquote className="rn-ql-passage">{excerpt}</blockquote>
      : article.summary ? <p className="rn-ql-summary">{article.summary}</p> : <Note>这篇文章没有摘要</Note>}
    {relevance ? <p className="rn-ql-reason"><span className="rn-ql-reason__why">{reasonLabel(relevance)}</span>{relevance.reason}</p>
      : <Note>筛子还没有为这篇写理由</Note>}
  </>
}

function DayLook({ data }: { data: Of<'day'> }) {
  const items = data.summary.items
  if (!items.length) return <Note>这一天还没有记录</Note>
  return <>{(Object.keys(DAY_ITEM_LABELS) as Array<keyof typeof DAY_ITEM_LABELS>).map(kind => {
    const rows = items.filter(item => item.kind === kind)
    return rows.length ? <section key={kind} className="rn-ql-group">
      <h3>{DAY_ITEM_LABELS[kind]}</h3>
      <ul>{rows.map(item => <li key={item.id}><RefCapsule reference={item.ref} title={item.title} />{item.detail && <span className="rn-ql-detail">{item.detail}</span>}</li>)}</ul>
    </section> : null
  })}</>
}

function EventLook({ data }: { data: Of<'event'> }) {
  const { event, start, end } = data
  const zone = event.timeZone || undefined
  const day = (at: number) => new Date(at).toLocaleDateString('zh-CN', { timeZone: zone, month: 'long', day: 'numeric', weekday: 'short' })
  const clock = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const when = event.allDay ? `${day(start)}${day(end - 1) !== day(start) ? ` – ${day(end - 1)}` : ''} · 全天`
    : day(start) === day(end) ? `${day(start)} ${clock(start)}–${clock(end)}` : `${day(start)} ${clock(start)} – ${day(end)} ${clock(end)}`
  return <>
    <p className="rn-ql-meta">{when}{event.location ? ` · ${event.location}` : ''}</p>
    {event.description ? <p className="rn-ql-summary">{event.description}</p> : <Note>没有日程说明</Note>}
  </>
}

function WebLook({ data }: { data: WebPreview }) {
  return <>
    <p className="rn-ql-url">{data.url}</p>
    {data.excerpts.length ? <ul className="rn-ql-excerpts">{data.excerpts.map(excerpt => <li key={excerpt.id}>
      <blockquote className="rn-ql-passage">{excerpt.text}</blockquote>
      {excerpt.note && <p className="rn-ql-annotation">{excerpt.note}</p>}
    </li>)}</ul> : <Note>这个网页还没有保存的摘录</Note>}
  </>
}

function ConversationLook({ data }: { data: Of<'conversation'> }) {
  return <div className="rn-ql-turn">
    <div className="rn-ql-turn__question"><span className="rn-ql-turn__label">问</span><p>{data.question}</p></div>
    <div className="rn-ql-turn__answer"><span className="rn-ql-turn__label">答</span>
      {data.answer ? <div className="rn-ql-prose"><ReactMarkdown>{data.answer}</ReactMarkdown></div> : <Note>这一轮还没有回答</Note>}
    </div>
  </div>
}

function FastCardLook({ data }: { data: Of<'fastcard'> }) {
  const { card } = data
  const source = sourceReference(card)
  return <div className="rn-ql-card">
    {card.kind === 'translation' && card.originalText && <blockquote className="rn-ql-passage">{card.originalText}</blockquote>}
    {itemPreview(card) && <p className="rn-ql-summary">{itemPreview(card)}</p>}
    {card.transcription?.status === 'ready' && <p className="rn-ql-summary">{card.transcription.text}</p>}
    <p className="rn-ql-meta">{source ? <RefCapsule reference={source} title={card.source?.pageTitle || sourceLabel(card)} /> : sourceLabel(card)} · {timeLabel(card.createdAt)}</p>
  </div>
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB']
const size = (bytes: number) => { let value = bytes, unit = 0; while (value >= 1024 && unit < SIZE_UNITS.length - 1) { value /= 1024; unit++ } return `${unit ? value.toFixed(1) : value} ${SIZE_UNITS[unit]}` }
function FileLook({ data }: { data: Of<'file'> }) {
  const { file } = data
  if (file.category === 'image') return <img className="rn-ql-media" src={file.localUrl} alt="" />
  if (file.category === 'video') return <video className="rn-ql-media" src={file.localUrl} controls preload="metadata" />
  if (file.category === 'audio') return <audio className="rn-ql-audio" src={file.localUrl} controls preload="metadata" />
  const label = file.category === 'pdf' ? 'PDF 文档' : file.category === 'ebook' ? '电子书' : `${file.extension.toUpperCase()} 文件`
  return <Note>{label}{file.size ? ` · ${size(file.size)}` : ''} · 打开后阅读</Note>
}

/**
 * A page as it reads, for the look only: no front matter, no heading that repeats the title, [[wiki]] links as their
 * alias or page name, callouts without their [!type] marker. The source itself is never touched.
 */
function readablePage(body: string, title: string) {
  const lines = body.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').split(/\r?\n/)
  const first = lines.findIndex(line => line.trim())
  if (first >= 0 && /^#\s/.test(lines[first]) && lines[first].replace(/^#\s+/, '').trim() === title.trim()) lines.splice(first, 1)
  return lines.join('\n')
    .replace(/(^|[^!])\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, before: string, target: string, alias?: string) => before + (alias ?? target.split('#')[0].split('/').pop() ?? target))
    .replace(/^(\s*>\s*)\[![\w-]+\][+-]?\s*/gm, '$1')
}

/** The body of a quick look; pages and text files keep the existing text preview. */
export function QuickLookBody({ preview, reference }: { preview: Extract<ObjectPreview, { state: 'ready' }>; reference?: PreviewTarget }) {
  const data = preview.data
  switch (data?.kind) {
    case 'database': return <DatabaseLook data={data} />
    case 'canvas': return <CanvasLook data={data} />
    case 'book': return <BookLook data={data} entry={reference?.kind === 'book-location' && reference.loc === 'c0:0+1'} />
    case 'rss-item': return <ArticleLook data={data} />
    case 'rss-digest': return <ul className="rn-ql-list">{data.entries.map((entry, index) => <li key={entry.groupKey ?? index}><strong>{entry.source.title}</strong><span>{entry.source.quote}</span></li>)}</ul>
    case 'rss-query': return <><Note>共 {data.total} 篇</Note><ul className="rn-ql-list">{data.items.map((item, index) => <li key={item.id ?? index}><strong>{item.title}</strong>{item.source && <span>{item.source}</span>}</li>)}</ul></>
    case 'day': return <DayLook data={data} />
    case 'event': return <EventLook data={data} />
    case 'web': return <WebLook data={data} />
    case 'conversation': return <ConversationLook data={data} />
    case 'fastcard': return <FastCardLook data={data} />
    case 'file': return <FileLook data={data} />
  }
  return preview.markdown ? <div className="rn-ql-prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{readablePage(preview.body, preview.title)}</ReactMarkdown></div>
    : <pre className="rn-ql-text">{preview.body}</pre>
}

