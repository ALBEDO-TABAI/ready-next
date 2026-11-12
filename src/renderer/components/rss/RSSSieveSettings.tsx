import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { GripVertical, PenLine, Plus } from 'lucide-react'
import type { RSSDefinition, RSSDefinitionWrite } from '../../../shared/rss-organization'
import type { RSSNotificationSettings, RSSSieveMetrics, RSSWorkContextSnapshot, RSSWorkPrivacy } from '../../../shared/rss-sieve'
import type { RSSProcessingStatus } from '../../../shared/rss-processing'
import { Button, IconButton } from '../ui/Button'
import { Switch } from '../ui/Toggle'
import { Input, Textarea } from '../ui/Field'
import { unwrapRSS } from '../../modules/rss/unwrap'
import RSSTopbarTools from './RSSTopbarTools'
import { RSSCalibrationCard } from './RSSCalibrationCard'

// 筛子设置 (W5 §4): replaces 管理栏目. Everything that decides what 为你筛过的 shows and how it reaches the person:
// 我的关注, 基础标准, topics in order with their 必须马上知道 switch, what the sieve may look at, notifications,
// the daily allowance, 换换口味, and how well it has been doing. Each control saves on its own.
const edit = (definition: RSSDefinition): RSSDefinitionWrite => ({ id: definition.id, expectedRevision: definition.revision, name: definition.name,
  description: definition.description, icon: definition.icon, visible: definition.visible, position: definition.position, filterIds: definition.filterIds })
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function RSSSieveSettings({ definitions, active, onEditTopic }: { definitions: RSSDefinition[]; active: boolean; onEditTopic(id: string): void }) {
  const api = window.electronAPI.rss
  const [error, setError] = useState('')
  const [metrics, setMetrics] = useState<RSSSieveMetrics | null>(null)
  const [urgent, setUrgent] = useState<Record<string, boolean>>({})
  const [quiet, setQuiet] = useState<RSSNotificationSettings | null>(null)
  const [privacy, setPrivacy] = useState<RSSWorkPrivacy | null>(null)
  const [work, setWork] = useState<RSSWorkContextSnapshot | null>(null)
  const [processing, setProcessing] = useState<RSSProcessingStatus | null>(null)
  const [explore, setExplore] = useState<boolean | null>(null)
  const load = useCallback(async () => {
    try {
      const [nextMetrics, topics, nextQuiet, nextPrivacy, nextWork, status, settings] = await Promise.all([unwrapRSS(api.sieveMetrics()), unwrapRSS(api.sieveTopicNotifications()),
        unwrapRSS(api.sieveNotificationSettings()), unwrapRSS(api.sievePrivacy()), unwrapRSS(api.sieveWorkContext()), unwrapRSS(api.processingStatus()), unwrapRSS(api.sieveSettings())])
      setMetrics(nextMetrics); setUrgent(Object.fromEntries(topics.map(entry => [entry.topicId, entry.urgent]))); setQuiet(nextQuiet)
      setPrivacy(nextPrivacy); setWork(nextWork); setProcessing(status); setExplore(settings.explore)
    } catch (cause) { setError(message(cause)) }
  }, [api])
  useEffect(() => { void load() }, [load])
  const run = async (work: () => Promise<unknown>) => {
    setError('')
    try { await work(); await load() } catch (cause) { setError(message(cause)) }
  }
  const curated = definitions.find(entry => entry.kind === 'curated')
  const topics = definitions.filter(entry => entry.kind === 'topic').sort((a, b) => a.position - b.position)
  return <section className="rss-sieve rss-sieve-settings" aria-label="筛子设置">
    <RSSTopbarTools slot="lead" show={active}><span>筛子设置</span></RSSTopbarTools>
    <div className="rss-sieve__inner">
      <header className="rss-sieve__head">
        <h1>筛子设置</h1>
        <p>决定哪些文章进“为你筛过的”，以及什么时候告诉你。</p>
      </header>
      {error && <p role="alert" className="rss-sieve__error">{error}</p>}
      <Metrics metrics={metrics} />
      <RSSCalibrationCard active={active} />
      <Section title="我的关注" hint="用自己的话写你关心什么。每次判断都会带上这段文字；每周的校准建议也要你确认后才会改它。">
        <FocusEditor onError={setError} />
      </Section>
      {curated && <Section title="基础标准" hint="每篇文章都先按这条标准判断：有明确的新进展、可靠的来源、实际的参考价值。">
        <StandardEditor key={curated.revision} definition={curated} onSave={description => run(() => unwrapRSS(api.saveDefinition({ ...edit(curated), description })))} />
      </Section>}
      <Section title="主题" hint="拖动调整顺序。打开“必须马上知道”的主题，最终分不低于 85 的文章会发系统通知，每天最多 3 条。">
        <TopicList topics={topics} urgent={urgent} onEdit={onEditTopic}
          onUrgent={(topicId, value) => run(() => unwrapRSS(api.sieveSaveTopicNotification({ topicId, urgent: value })))}
          onReorder={ordered => run(async () => {
            for (const [index, topic] of ordered.entries()) {
              const position = (index + 1) * 10
              if (topic.position !== position) await unwrapRSS(api.saveDefinition({ ...edit(topic), position }))
            }
          })} />
        <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => onEditTopic('new-topic')}>新建主题</Button>
      </Section>
      {quiet && <Section title="通知" hint="只有“必须马上知道”的主题会发通知。静默时段内不发。">
        <div className="rss-sieve-settings__row">
          <span>静默时段</span>
          <span className="rss-sieve-settings__times">
            <Input type="time" aria-label="静默开始" value={quiet.quietStart} onChange={event => { const next = { ...quiet, quietStart: event.target.value }; if (event.target.value) void run(() => unwrapRSS(api.sieveSaveNotificationSettings(next))) }} />
            <span aria-hidden>–</span>
            <Input type="time" aria-label="静默结束" value={quiet.quietEnd} onChange={event => { const next = { ...quiet, quietEnd: event.target.value }; if (event.target.value) void run(() => unwrapRSS(api.sieveSaveNotificationSettings(next))) }} />
          </span>
        </div>
      </Section>}
      {privacy && <Section title="在做的事" hint="开启后，筛子会参考你正在写的页面、近期日程和在读的书，把相关的文章排到前面。下面的清单只含标题，会原样随判断请求发给你配置的模型服务商。">
        <Toggle label="让筛子参考我正在做的事" checked={privacy.enabled}
          onChange={value => void run(() => unwrapRSS(api.sieveConfigurePrivacy({ answer: value ? 'enabled' : 'later', enabled: value })))} />
        {privacy.enabled && <>
          <Toggle label="页面标题" checked={privacy.pages} onChange={value => void run(() => unwrapRSS(api.sieveConfigurePrivacy({ pages: value })))} />
          <Toggle label="日程标题" detail="日程标题里常有人名，可以单独关掉。" checked={privacy.calendar} onChange={value => void run(() => unwrapRSS(api.sieveConfigurePrivacy({ calendar: value })))} />
          <Toggle label="在读的书" checked={privacy.books} onChange={value => void run(() => unwrapRSS(api.sieveConfigurePrivacy({ books: value })))} />
          <div className="rss-sieve-settings__preview">
            <p>此刻会发出去的清单</p>
            {work?.entries.length
              ? <ul className="rss-sieve__consent-list" aria-label="将会发送的清单">{work.entries.map((entry, index) => <li key={index}>{entry.title}</li>)}</ul>
              : <p className="rss-sieve__meta">现在没有可以参考的标题。</p>}
          </div>
        </>}
      </Section>}
      {processing && <Section title="额度" hint="每篇文章判断一次，用一次额度。用完后新文章排队，第二天继续。">
        <Toggle label="自动判断新文章" checked={processing.settings.enabled}
          onChange={value => void run(() => unwrapRSS(api.configureProcessing({ ...processing.settings, enabled: value })))} />
        <LimitEditor key={processing.settings.dailyLimit} status={processing} onSave={dailyLimit => run(() => unwrapRSS(api.configureProcessing({ ...processing.settings, dailyLimit })))} />
      </Section>}
      {explore !== null && <Section title="换换口味" hint="每天从没达到门槛的文章里随手放一篇到列表末尾，免得只看到熟悉的东西。">
        <Toggle label="每天放一篇“换换口味”" checked={explore} onChange={value => void run(() => unwrapRSS(api.sieveSaveSettings({ explore: value })))} />
      </Section>}
    </div>
  </section>
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return <section className="rss-sieve-settings__section" aria-label={title}>
    <h2>{title}</h2>
    <p className="rss-sieve-settings__hint">{hint}</p>
    <div className="rss-sieve-settings__body">{children}</div>
  </section>
}

function Toggle({ label, detail, checked, onChange }: { label: string; detail?: string; checked: boolean; onChange(value: boolean): void }) {
  return <div className="rss-sieve-settings__row">
    <span>{label}{detail && <small>{detail}</small>}</span>
    <Switch label={label} checked={checked} onChange={onChange} />
  </div>
}

function Metrics({ metrics }: { metrics: RSSSieveMetrics | null }) {
  if (!metrics) return null
  const rate = metrics.hitRate === null ? '—' : `${Math.round(metrics.hitRate * 100)}%`
  return <dl className="rss-sieve-settings__metrics" aria-label="过去 14 天">
    <div><dt>筛过</dt><dd>{metrics.screened} 篇</dd></div>
    <div><dt>命中率</dt><dd>{rate}</dd></div>
    <div><dt>漏网</dt><dd>{metrics.missed} 篇</dd></div>
    <p className="rss-sieve__meta">过去 14 天。命中是筛过的文章被你打开、收藏或收下；漏网是你收藏或收下、但当时没被筛出来的。</p>
  </dl>
}

function FocusEditor({ onError }: { onError(message: string): void }) {
  const [focus, setFocus] = useState<{ version: number; text: string } | null>(null)
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)
  const load = useCallback(async () => {
    try { const next = await unwrapRSS(window.electronAPI.rss.sieveFocus()); setFocus(next); setDraft(next.text) } catch (cause) { onError(message(cause)) }
  }, [onError])
  useEffect(() => { void load() }, [load])
  if (!focus) return null
  const save = async () => {
    try { const next = await unwrapRSS(window.electronAPI.rss.sieveSaveFocus({ text: draft, expectedVersion: focus.version })); setFocus(next); setDraft(next.text); setSaved(true) }
    catch (cause) { onError(message(cause)); await load() }
  }
  return <>
    <Textarea className="rss-calibration__draft" aria-label="我的关注" rows={5} value={draft} placeholder="例如：独立出版的发行与定价；AI 视频制作的新工具；不想看融资新闻。"
      onChange={event => { setDraft(event.target.value); setSaved(false) }} />
    <div className="rss-sieve-settings__actions">
      {saved && <span className="rss-sieve__meta" role="status">已保存</span>}
      <Button size="sm" variant="secondary" disabled={draft === focus.text} onClick={() => void save()}>保存</Button>
    </div>
  </>
}

function StandardEditor({ definition, onSave }: { definition: RSSDefinition; onSave(description: string): Promise<void> }) {
  const [draft, setDraft] = useState(definition.description)
  return <>
    <Textarea className="rss-calibration__draft" aria-label="基础标准" rows={4} value={draft} onChange={event => setDraft(event.target.value)} />
    <div className="rss-sieve-settings__actions">
      <span className="rss-sieve__meta">改了标准，已判断过的文章会按新标准重判。</span>
      <Button size="sm" variant="secondary" disabled={!draft.trim() || draft === definition.description} onClick={() => void onSave(draft.trim())}>保存</Button>
    </div>
  </>
}

function LimitEditor({ status, onSave }: { status: RSSProcessingStatus; onSave(limit: number): Promise<void> }) {
  const [draft, setDraft] = useState(String(status.settings.dailyLimit))
  const value = Number(draft), valid = Number.isInteger(value) && value >= 1 && value <= 10000
  return <div className="rss-sieve-settings__row">
    <span>每天最多判断<small>今天已用 {status.callsToday} 次{status.pending ? `，排队 ${status.pending} 篇` : ''}</small></span>
    <span className="rss-sieve-settings__times">
      <Input type="number" min={1} max={10000} aria-label="每天最多判断的次数" value={draft} onChange={event => setDraft(event.target.value)}
        onBlur={() => { if (valid && value !== status.settings.dailyLimit) void onSave(value) }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
      <span>次</span>
    </span>
  </div>
}

function TopicList({ topics, urgent, onEdit, onUrgent, onReorder }: {
  topics: RSSDefinition[]; urgent: Record<string, boolean>; onEdit(id: string): void
  onUrgent(topicId: string, value: boolean): void; onReorder(ordered: RSSDefinition[]): void
}) {
  const dragging = useRef<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  if (!topics.length) return <p className="rss-sieve__meta">还没有主题。</p>
  const move = (id: string, target: number) => {
    const ordered = topics.filter(topic => topic.id !== id)
    ordered.splice(Math.max(0, Math.min(target, ordered.length)), 0, topics.find(topic => topic.id === id)!)
    if (ordered.some((topic, index) => topic.id !== topics[index].id)) onReorder(ordered)
  }
  const drop = (event: DragEvent, targetId: string) => {
    event.preventDefault(); setOver(null)
    const id = dragging.current; dragging.current = null
    if (id && id !== targetId) move(id, topics.findIndex(topic => topic.id === targetId))
  }
  const keys = (event: KeyboardEvent, id: string, index: number) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault(); move(id, index + (event.key === 'ArrowUp' ? -1 : 1))
  }
  return <ol className="rss-sieve-settings__topics" aria-label="主题，按 Alt 加上下方向键调整顺序">
    {topics.map((topic, index) => <li key={topic.id} draggable data-over={over === topic.id || undefined} tabIndex={0} aria-label={topic.name}
      onDragStart={event => { dragging.current = topic.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', topic.name) }}
      onDragOver={event => { if (dragging.current) { event.preventDefault(); setOver(topic.id) } }}
      onDragLeave={() => setOver(current => current === topic.id ? null : current)}
      onDragEnd={() => { dragging.current = null; setOver(null) }}
      onDrop={event => drop(event, topic.id)} onKeyDown={event => keys(event, topic.id, index)}>
      <GripVertical size={14} className="rss-sieve-settings__grip" aria-hidden />
      <span className="rss-sieve-settings__topic">{topic.name}<small>{topic.description}</small></span>
      <span className="rss-sieve-settings__urgent">必须马上知道<Switch label={`${topic.name}：必须马上知道`} checked={!!urgent[topic.id]} onChange={value => onUrgent(topic.id, value)} /></span>
      <IconButton size="sm" icon={<PenLine size={14} />} title={`编辑 ${topic.name}`} onClick={() => onEdit(topic.id)} />
    </li>)}
  </ol>
}
