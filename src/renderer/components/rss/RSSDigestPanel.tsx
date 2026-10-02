import { useEffect, useMemo, useRef, useState } from 'react'
import type { RSSDigestHeader, RSSDigestEntry, RSSDigestSource, RSSDigestCoverageSource, RSSDigestScheduleState, RSSDigestCriteria } from '../../../shared/rss-digests'
import type { RSSQueryResult } from '../../../shared/rss-workspace'
import { useRSSSession } from '../../stores/useRSSSession'
import { toRSSItem } from '../../modules/rss/workspace-query'
import type { RSSItem } from './RSSFeed'
import RSSReferenceButton from './RSSReferenceButton'
import { openWebpageInBrowser } from '../../modules/browser/openWebpageInBrowser'
import { ChevronRight, Download, RefreshCw, Settings2 } from 'lucide-react'
import RSSCoverImage from './RSSCoverImage'
import RSSTopbarTools from './RSSTopbarTools'

const time = (value: number, timezone: string) => new Date(value).toLocaleString(undefined, { timeZone: timezone })
const editionDate = (value: number, timezone: string, withTime: boolean) => new Date(value).toLocaleString('zh-CN', {
  timeZone: timezone, month: 'long', day: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
})
function Sources({ reportId, groupKey, criteria = false, onRead }: { reportId: string; groupKey?: string; criteria?: boolean; onRead(source: RSSDigestSource): void }) {
  const [rows, setRows] = useState<Array<RSSDigestSource | RSSDigestCoverageSource | RSSDigestCriteria>>([]), [next, setNext] = useState<number | null>(0)
  const [open, setOpen] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const read = async () => {
    setBusy(true); setError('')
    try {
      const result = await window.electronAPI.rss.readDigests({ view: groupKey ? 'sources' : criteria ? 'criteria' : 'coverage', reportId, groupKey, offset: next ?? 0 })
      if (!alive.current) return
      if (!result.success || !result.data || !['sources', 'coverage', 'criteria'].includes(result.data.view)) throw new Error(result.error || '依据读取失败')
      const data = result.data as Extract<NonNullable<typeof result.data>, { view: 'sources' | 'coverage' | 'criteria' }>
      setRows((old) => [...old, ...(data.view === 'criteria' ? data.criteria : data.sources)]); setNext(data.nextOffset)
    } catch (cause) { if (alive.current) setError(String(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <div className="rss-digest-sources">
    <button type="button" onClick={() => { setOpen(!open); if (!open && !busy && rows.length === 0 && next !== null) void read() }} aria-expanded={open}>{groupKey ? '查看全部报道依据' : criteria ? '查看本刊采用的标准版本' : '查看订阅覆盖与采集情况'}</button>
    {open && <>
      {rows.map((row) => 'itemId' in row ? <div key={`${row.itemId}:${row.articleRevision}`}>
        <strong>{row.source} · {row.title}</strong><blockquote>{row.quote}</blockquote>
        <p>{row.quoteKind === 'source_summary' ? '来源摘要' : row.quoteKind === 'title' ? '仅有标题' : '原文摘句'}{row.quoteTruncated ? ' · 节选' : ''} · {row.bodyStatus === 'ready' ? '已保存正文' : '正文不完整或尚未获取'}</p>
        {row.curation && <p>{row.curation.origin === 'manual' ? '手工精选' : '模型精选理由'}：{row.curation.reason}</p>}
        <button type="button" onClick={() => onRead(row)}>阅读对应版本</button>
        <button type="button" onClick={() => void openWebpageInBrowser(row.link)}>打开原网站</button>
      </div> : 'ruleRevision' in row ? <div key={row.id}><strong>{row.name} · 标准第 {row.ruleRevision} 版</strong><p>{row.description}</p></div> : <div key={row.id}><strong>{row.name}</strong><p>{row.enabled ? '已启用' : '已停用'} · {row.fetch ? `${row.fetch.attemptedAt} · ${row.fetch.success ? '最近采集成功' : '最近采集失败'}` : '缺少最近采集结果'}{row.fetch?.error ? ` · ${row.fetch.error}` : ''}{row.fetch?.warning ? ` · ${row.fetch.warning}` : ''}</p></div>)}
      {next !== null && <button type="button" disabled={busy} onClick={() => void read()}>{busy ? '读取中…' : '继续读取依据'}</button>}
      {error && <p className="rss-note rss-note--danger" role="alert">{error}</p>}
    </>}
  </div>
}

export default function RSSDigestPanel({ active, view, onReadArticle }: { active: boolean; view: RSSQueryResult | null; onReadArticle(item: RSSItem): void }) {
  const selected = useRSSSession((s) => s.selectedDigestId), setDigestView = useRSSSession((s) => s.setDigestView)
  const [editions, setEditions] = useState<RSSDigestHeader[]>([]), [editionNext, setEditionNext] = useState<number | null>(null), [snapshot, setSnapshot] = useState<number>()
  const [listed, setListed] = useState(false)
  const [report, setReport] = useState<RSSDigestHeader | null>(null), [entries, setEntries] = useState<RSSDigestEntry[]>([]), [next, setNext] = useState<number | null>(null)
  const [settings, setSettings] = useState<RSSDigestScheduleState | null>(null), [draftTime, setDraftTime] = useState('08:00')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tab, setTab] = useState<RSSDigestHeader['kind']>('daily')
  const [foldedMonths, setFoldedMonths] = useState<Set<string>>(() => new Set())
  const [leadCover, setLeadCover] = useState<{ link: string; coverImage: string | null } | null>(null)
  const listTicket = useRef(0), readTicket = useRef(0), actionTicket = useRef(0), dirtyTime = useRef(false)
  const mainRef = useRef<HTMLDivElement>(null)
  const list = async (more = false) => {
    const ticket = ++listTicket.current
    const result = await window.electronAPI.rss.readDigests({ offset: more ? editionNext ?? 0 : 0, snapshot: more ? snapshot : undefined, limit: 50 })
    if (ticket !== listTicket.current) return
    if (!result.success || result.data?.view !== 'editions') throw new Error(result.error || '刊物目录读取失败')
    const data = result.data; setEditions((old) => more ? [...old, ...data.editions] : data.editions); setEditionNext(data.nextOffset); setSnapshot(data.snapshot); setListed(true)
  }
  // An edition is read whole (bounded) so the headline, highlights and section index describe the entire issue.
  const read = async (id: string, more = false) => {
    const ticket = ++readTicket.current
    let offset = more ? next ?? 0 : 0, nextOffset: number | null = offset, header: RSSDigestHeader | null = null
    const loaded: RSSDigestEntry[] = []
    for (let page = 0; page < 10 && nextOffset !== null; page += 1) {
      const result = await window.electronAPI.rss.readDigests({ view: 'entries', reportId: id, offset, limit: 50 })
      if (ticket !== readTicket.current || useRSSSession.getState().selectedDigestId !== id) return
      if (!result.success || result.data?.view !== 'entries') throw new Error(result.error || '刊物读取失败')
      header = result.data.report; loaded.push(...result.data.entries); nextOffset = result.data.nextOffset; offset = nextOffset ?? offset
    }
    setReport(header); setEntries((old) => more ? [...old, ...loaded] : loaded); setNext(nextOffset)
  }
  useEffect(() => {
    if (!active) return
    let live = true
    const reload = () => { void list().catch((e) => { if (live) setError(String(e)) }) }
    reload()
    void window.electronAPI.rss.digestSettings().then((result) => {
      if (!live) return
      if (!result.success || !result.data) { setError(result.error || '日报设置不可用'); return }
      setSettings(result.data); if (!dirtyTime.current) setDraftTime(result.data.localTime)
    })
    const refresh = () => {
      reload()
      void window.electronAPI.rss.digestSettings().then((result) => {
        if (live && result.success && result.data) { setSettings(result.data); if (!dirtyTime.current) setDraftTime(result.data.localTime) }
      }).catch((error) => { if (live) setError(String(error)) })
      const id = useRSSSession.getState().selectedDigestId
      if (id) void window.electronAPI.rss.readDigests({ view: 'entries', reportId: id, limit: 1 }).then((result) => {
        if (live && useRSSSession.getState().selectedDigestId === id && result.success && result.data?.view === 'entries') setReport(result.data.report)
      }).catch((error) => { if (live) setError(String(error)) })
    }
    const off = window.electronAPI.rss.onDigestsChanged(refresh), offOrganization = window.electronAPI.rss.onOrganizationChanged(refresh)
    return () => { live = false; ++listTicket.current; ++readTicket.current; ++actionTicket.current; off(); offOrganization() }
  }, [active])
  useEffect(() => {
    ++actionTicket.current; setBusy(false); setReport(null); setEntries([]); setNext(null); setError(''); setNotice(''); setLeadCover(null)
    if (!active || !selected) return
    void read(selected).catch((e) => setError(String(e)))
    return () => { ++readTicket.current }
  }, [selected, active])
  // Like a newspaper rack: opening the view shows the latest issue of the current shelf.
  useEffect(() => {
    if (!active || !listed || selected) return
    const latest = editions.find((edition) => edition.kind === tab) || editions[0]
    if (latest) setDigestView(true, latest.id)
  }, [active, listed, selected, editions, tab, setDigestView])
  useEffect(() => { if (report) setTab(report.kind) }, [report?.id])
  const action = async (run: () => Promise<void>) => {
    const ticket = ++actionTicket.current; setBusy(true); setError(''); setNotice('')
    try { await run() } catch (cause) { if (ticket === actionTicket.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (ticket === actionTicket.current) setBusy(false) }
  }
  const generate = async (kind: 'range' | 'regenerate') => {
    if (kind === 'range' && !view || kind === 'regenerate' && !report) return
    const expected = useRSSSession.getState().selectedDigestId, ticket = actionTicket.current
    const result = await window.electronAPI.rss.generateDigest(kind === 'range' ? { kind, query: { ...view!.query, expectedRevision: view!.revision } } : { kind, reportId: report!.id })
    if (!result.success || !result.data) throw new Error(result.error || '生成失败')
    if (ticket !== actionTicket.current || !useRSSSession.getState().digestVisible || useRSSSession.getState().selectedDigestId !== expected) return
    await list(); if (ticket === actionTicket.current && useRSSSession.getState().selectedDigestId === expected) setDigestView(true, result.data.id)
  }
  const readArticle = (source: RSSDigestSource) => { void action(async () => {
    const expected = useRSSSession.getState().selectedDigestId, ticket = actionTicket.current
    const result = await window.electronAPI.rss.readArticle({ itemId: source.itemId, expectedRevision: source.articleRevision, length: 1 })
    if (!result.success || !result.data) throw new Error('原文已变化或删除；本刊仍保留发布时的摘句，不跳到其他版本。')
    if (ticket === actionTicket.current && useRSSSession.getState().digestVisible && useRSSSession.getState().selectedDigestId === expected) onReadArticle({ ...toRSSItem(result.data.article), pinnedRevision: source.articleRevision })
  }) }
  const kindLabel = (kind: RSSDigestHeader['kind']) => kind === 'daily' ? '日报' : '范围简报'

  // Headline = the most-reported story; highlights = the next ones; sections index the rest.
  const ranked = useMemo(() => entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.referenceCount - a.entry.referenceCount || a.index - b.index).map(({ entry }) => entry), [entries])
  const lead = ranked[0] || null
  const highlights = ranked.slice(1, 4)
  const sections = useMemo(() => {
    const groups: Array<{ name: string; entries: RSSDigestEntry[] }> = []
    for (const entry of entries) {
      if (entry === lead) continue
      const group = groups.find((candidate) => candidate.name === entry.section)
      if (group) group.entries.push(entry); else groups.push({ name: entry.section, entries: [entry] })
    }
    return groups
  }, [entries, lead])
  const sourceCount = useMemo(() => new Set(entries.map((entry) => entry.source.sourceId)).size, [entries])
  const readingMinutes = Math.max(1, Math.round(entries.reduce((sum, entry) => sum + entry.source.title.length + entry.source.quote.length, 0) / 450))
  useEffect(() => {
    if (!lead || !active) return
    let live = true
    void window.electronAPI.rss.readArticle({ itemId: lead.source.itemId, expectedRevision: lead.source.articleRevision, length: 1 }).then((result) => {
      if (live && result.success && result.data) setLeadCover({ link: result.data.article.link, coverImage: result.data.article.coverImage })
    }).catch(() => { /* silent-catch: the headline simply shows no image when its article is gone. */ })
    return () => { live = false }
  }, [lead?.groupKey, lead?.source.itemId, active])
  const shelf = editions.filter((edition) => edition.kind === tab)
  const months = useMemo(() => {
    const groups: Array<{ key: string; label: string; editions: RSSDigestHeader[] }> = []
    for (const edition of shelf) {
      const parts = dateParts(edition.until, edition.timezone)
      const key = `${parts.year}-${parts.month}`
      const group = groups.find((candidate) => candidate.key === key)
      if (group) group.editions.push(edition); else groups.push({ key, label: `${parts.year} 年 ${parts.month} 月`, editions: [edition] })
    }
    return groups
  }, [shelf])
  const scrollTo = (id: string) => mainRef.current?.querySelector(`[data-digest-anchor="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const reportDate = report ? dateParts(report.until, report.timezone) : null
  const sources = (entry: RSSDigestEntry) => <Sources key={`${report!.id}:${entry.groupKey}`} reportId={report!.id} groupKey={entry.groupKey} onRead={readArticle} />

  return <section className="rss-digest-panel" aria-label="日报与简报">
    <RSSTopbarTools slot="lead" show={active}><span>日报与简报</span></RSSTopbarTools>
    <aside className="rss-digest-side">
      <div className="rss-digest-side__actions">
        <div className="sx-seg" role="tablist" aria-label="刊物类型">
          {(['daily', 'range'] as const).map((kind) => <button type="button" role="tab" key={kind} className="sx-seg__item" aria-selected={tab === kind} onClick={() => setTab(kind)}>{kind === 'daily' ? '日报' : '简报'}</button>)}
        </div>
        <button type="button" className="rss-btn rss-btn--icon" aria-label="日报设置" title="日报时间与覆盖" aria-pressed={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}><Settings2 size={15} strokeWidth={1.8} /></button>
      </div>
      <button type="button" className="sx-btn sx-btn--sm rss-digest-generate" disabled={busy || !view} onClick={() => void action(() => generate('range'))}>生成当前筛选范围简报</button>
      <p>往期</p>
      <nav className="rss-digest-editions" aria-label="已保存刊物">
        {months.map((month) => {
          const folded = foldedMonths.has(month.key)
          return <div className="rss-digest-month" key={month.key}>
            <button type="button" className="rss-digest-month__head" aria-expanded={!folded}
              onClick={() => setFoldedMonths((old) => { const nextSet = new Set(old); if (nextSet.has(month.key)) nextSet.delete(month.key); else nextSet.add(month.key); return nextSet })}>
              <ChevronRight size={13} strokeWidth={2} /><span>{month.label}</span><small>{month.editions.length}</small>
            </button>
            {!folded && month.editions.map((edition) => {
              const parts = dateParts(edition.until, edition.timezone)
              return <button type="button" key={edition.id} className="rss-digest-issue" aria-current={selected === edition.id ? 'page' : undefined} onClick={() => setDigestView(true, edition.id)}
                aria-label={`${kindLabel(edition.kind)} · ${editionDate(edition.until, edition.timezone, edition.kind === 'range')}`}>
                <span className="rss-digest-issue__day"><strong>{parts.day.padStart(2, '0')}</strong><small>{edition.kind === 'range' ? parts.time : parts.weekday.replace('星期', '周')}</small></span>
                <span className="rss-digest-issue__title">{edition.lead?.title || (edition.total ? `${edition.total} 项入选` : '本期暂无入选内容')}
                  {edition.version > 1 || edition.needsUpdate ? <small>{edition.version > 1 ? `第 ${edition.version} 版` : ''}{edition.needsUpdate ? `${edition.version > 1 ? ' · ' : ''}需更新` : ''}</small> : null}</span>
              </button>
            })}
          </div>
        })}
        {!shelf.length && <p>{tab === 'daily' ? '还没有日报。日报会在设定时间按已入选的资讯自动生成。' : '还没有简报。可以为当前筛选范围生成一份。'}</p>}
        {editionNext !== null && <button type="button" className="rss-digest-older" onClick={() => void action(() => list(true))}>更早刊物</button>}
      </nav>
    </aside>
    <div className="rss-digest-main" ref={mainRef}>
      {settingsOpen && <div className="rss-digest-settings">
        <div className="rss-processing-panel__row">
          <div><strong>自动生成日报</strong><small>按本机时区每天生成；关闭或休眠后补最近一期。不会发送到外部，也不会再次调用模型扩写新闻。</small></div>
          {settings && <button type="button" role="switch" aria-checked={settings.enabled} aria-label="自动生成日报" className="sx-switch" data-checked={settings.enabled ? 'true' : 'false'} disabled={busy}
            onClick={() => void action(async () => {
              const result = await window.electronAPI.rss.configureDigests({ enabled: !settings.enabled, localTime: settings.localTime }); if (!result.success || !result.data) throw new Error(result.error); setSettings(result.data)
            })} />}
        </div>
        {settings && <div className="rss-processing-panel__row">
          <div><strong>当地时间</strong><small>{settings.timezone} · 下次：{settings.enabled && settings.nextRunAt ? new Date(settings.nextRunAt).toLocaleString() : '已关闭'}</small></div>
          <div className="rss-processing-panel__limit">
            <input className="sx-input" type="time" aria-label="日报当地时间" value={draftTime} onChange={(e) => { dirtyTime.current = true; setDraftTime(e.target.value) }} />
            <button type="button" className="sx-btn sx-btn--sm" disabled={busy || !draftTime} onClick={() => void action(async () => { const result = await window.electronAPI.rss.configureDigests({ enabled: settings.enabled, localTime: draftTime }); if (!result.success || !result.data) throw new Error(result.error); setSettings(result.data); dirtyTime.current = false })}>保存日报时间</button>
          </div>
        </div>}
        {settings?.error && <p className="rss-note rss-note--danger" role="alert">上次生成未完成：{settings.error}。会在下次启动、恢复或定时触发时重试。</p>}
      </div>}
      {report && reportDate ? <article className="rss-paper">
        <div className="rss-paper-masthead">
          <span>{reportDate.year} 年 {reportDate.month} 月 {reportDate.day} 日 · {reportDate.weekday}</span>
          <span className="rss-paper-masthead__scope" title={report.scopeLabel}>{report.kind === 'daily' ? '资讯 · 每日要闻' : report.scopeLabel}</span>
          <span>{report.kind === 'daily' ? `每天 ${settings?.localTime || '08:00'} 出刊` : `生成于 ${reportDate.time}`}</span>
        </div>
        <header className="rss-paper-head">
          <div className="min-w-0">
            <h1>{report.kind === 'daily' ? '资讯日报' : '当前范围简报'}<small> · 第 {report.version} 版</small></h1>
            <p className="rss-paper-kicker">READY · RSS</p>
          </div>
          {report.kind === 'daily' && <div className="rss-paper-date" aria-hidden>
            <div className="rss-paper-date__tile"><strong>{reportDate.day.padStart(2, '0')}</strong><span>{reportDate.year} 年 {reportDate.month} 月</span><span>{reportDate.weekday}</span></div>
            <MonthDots report={report} editions={editions} onOpen={(id) => setDigestView(true, id)} />
          </div>}
        </header>
        <div className="rss-paper-stats">
          <span><b>{report.total}</b>件入选</span><span><b>{sourceCount}</b>个来源</span><span><b>{report.referenceCount}</b>条依据</span>
          <span className="rss-paper-stats__end">{report.total ? `约 ${readingMinutes} 分钟读完` : '本期暂无入选'}</span>
        </div>
        {report.needsUpdate && <p className="rss-note" role="status">来源、标准或归属已经变化；这里保留发布时的内容，可重新生成新版本。</p>}
        <div className="rss-paper-grid">
          <div className="rss-paper-body">
            {!report.total && <p className="rss-note">本期暂无已入选的可用内容，不代表没有新闻。可在右侧查看订阅覆盖与采集情况。</p>}
            {lead && <section className="rss-paper-lead" data-digest-anchor={lead.groupKey}>
              <p className="rss-paper-label">头条</p>
              <h2>{lead.source.title}</h2>
              <div className="rss-paper-lead__body">
                <blockquote>{lead.source.quote}</blockquote>
                {leadCover && <RSSCoverImage link={leadCover.link} coverImage={leadCover.coverImage} variant="preview" />}
              </div>
              <EntryMeta entry={lead} />
              {sources(lead)}
            </section>}
            {sections.map((section) => <section key={section.name} className="rss-paper-section" data-digest-anchor={`section:${section.name}`}>
              <p className="rss-paper-label">{section.name}</p>
              {section.entries.map((entry) => <div className="rss-digest-entry" key={entry.groupKey} data-digest-anchor={entry.groupKey}>
                <h2>{entry.source.title}</h2><blockquote>{entry.source.quote}</blockquote>
                <EntryMeta entry={entry} />
                {sources(entry)}
              </div>)}
            </section>)}
            {next !== null && <button type="button" className="rss-load-more" disabled={busy} onClick={() => void action(() => read(report.id, true))}>更多条目</button>}
          </div>
          {(highlights.length > 0 || sections.length > 0) && <nav className="rss-paper-guide" aria-label="本期导读">
            {highlights.length > 0 && <section>
              <p className="rss-paper-label">今日看点</p>
              <ol className="rss-paper-highlights">{highlights.map((entry, index) => <li key={entry.groupKey}>
                <span>{index + 1}</span><button type="button" onClick={() => scrollTo(entry.groupKey)}><strong>{entry.source.title}</strong><small>{entry.source.source}</small></button>
              </li>)}</ol>
            </section>}
            {sections.length > 0 && <section>
              <p className="rss-paper-label">本期版面</p>
              <ol className="rss-paper-index">{sections.map((section, index) => <li key={section.name}>
                <button type="button" onClick={() => scrollTo(`section:${section.name}`)}><span>{String(index + 1).padStart(2, '0')}</span><strong>{section.name}</strong><small>{section.entries.length} 件</small></button>
              </li>)}</ol>
            </section>}
          </nav>}
          <aside className="rss-paper-info">
            <section>
              <p className="rss-paper-label">本刊信息</p>
              <p className="rss-digest-meta">{report.kind === 'daily' ? `${time(report.from, report.timezone)} 至 ${time(report.until, report.timezone)}（不含截止时刻）` : report.scopeLabel} · {report.timezone} · 生成于 {time(report.createdAt, report.timezone)}</p>
              <p className="rss-digest-meta">{report.total} 项 · {report.referenceCount} 条报道依据；未得明确精选判断 {report.coverage.unresolvedArticles} 篇，其中有失败或未知任务 {report.coverage.failedArticles} 篇；等待整理 {report.coverage.pendingArticles} 篇。正文不完整或缺失 {report.coverage.missingBodies} 篇，补收 {report.coverage.carriedOverArticles} 篇。</p>
              <div className="rss-digest-actions">
                <RSSReferenceButton name={`${report.kind === 'daily' ? '日报' : '范围简报'} 第 ${report.version} 版`} label="引用本刊" reference={{ kind: 'digest', read: { reportId: report.id, offset: 0, limit: 20 } }} />
                <button type="button" className="rss-btn" disabled={busy} onClick={() => void action(() => generate('regenerate'))}><RefreshCw size={14} strokeWidth={1.8} />重新生成新版本</button>
                <button type="button" className="rss-btn" disabled={busy} onClick={() => void action(async () => { const ticket = actionTicket.current; const result = await window.electronAPI.rss.exportDigest({ reportId: report.id }); if (!result.success || !result.data) throw new Error(result.error); if (ticket === actionTicket.current) setNotice(result.data.canceled ? '已取消导出' : `已导出：${result.data.path}`) })}><Download size={14} strokeWidth={1.8} />导出本刊</button>
              </div>
              <Sources key={`${report.id}:criteria`} reportId={report.id} criteria onRead={readArticle} />
              <Sources key={`${report.id}:coverage`} reportId={report.id} onRead={readArticle} />
            </section>
          </aside>
        </div>
      </article> : <div className="rss-digest-empty">
        <h1>日报与简报</h1>
        <p>{editions.length ? '从左侧选择一期查看。日报只汇总已入选的资讯与原文摘句，不再调用模型扩写。' : '这里会保存每天的资讯日报，以及你为某个筛选范围生成的简报。'}</p>
      </div>}
      {notice && <p className="rss-note" role="status" style={{ marginTop: 16 }}>{notice}</p>}{error && <p className="rss-note rss-note--danger" role="alert" style={{ marginTop: 16 }}>{error}</p>}
    </div>
  </section>
}

function EntryMeta({ entry }: { entry: RSSDigestEntry }) {
  const topics = entry.source.topics.map((topic) => topic.name).join(' · ')
  return <>
    <p className="rss-paper-entry-meta">{entry.source.source} · {entry.source.quoteKind === 'source_summary' ? '来源摘要' : entry.source.quoteKind === 'title' ? '仅标题' : '原文摘句'}{entry.source.quoteTruncated ? ' · 节选' : ''}{entry.referenceCount > 1 ? ` · ${entry.referenceCount} 个来源报道` : ''}{topics ? ` · ${topics}` : ''}</p>
    {entry.source.curation && <p className="rss-paper-reason">{entry.source.curation.origin === 'manual' ? '手工精选' : '推荐理由'}：{entry.source.curation.reason}</p>}
  </>
}

// Month of the issue as a quiet dot grid; days that have a daily issue can be opened.
function MonthDots({ report, editions, onOpen }: { report: RSSDigestHeader; editions: RSSDigestHeader[]; onOpen(id: string): void }) {
  const parts = dateParts(report.until, report.timezone)
  const year = Number(parts.year), month = Number(parts.month)
  const first = new Date(year, month - 1, 1).getDay(), days = new Date(year, month, 0).getDate()
  const issues = new Map<number, string>()
  for (const edition of editions) {
    if (edition.kind !== 'daily') continue
    const day = dateParts(edition.until, edition.timezone)
    if (Number(day.year) === year && Number(day.month) === month && !issues.has(Number(day.day))) issues.set(Number(day.day), edition.id)
  }
  const offset = (first + 6) % 7
  return <div className="rss-paper-calendar">
    <div className="rss-paper-calendar__head"><span>{month} 月</span><small>本月 {issues.size} 期</small></div>
    <div className="rss-paper-calendar__grid">
      {['一', '二', '三', '四', '五', '六', '日'].map((label) => <span key={label} className="is-label">{label}</span>)}
      {Array.from({ length: offset }).map((_, index) => <span key={`pad-${index}`} />)}
      {Array.from({ length: days }).map((_, index) => {
        const day = index + 1, id = issues.get(day)
        return id ? <button type="button" key={day} title={`${month}月${day}日日报`} className={id === report.id ? 'is-current' : 'is-issue'} onClick={() => onOpen(id)} />
          : <span key={day} className="is-day" />
      })}
    </div>
  </div>
}

function dateParts(value: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(value)).map((part) => [part.type, part.value]))
  return { year: parts.year, month: parts.month, day: parts.day, weekday: parts.weekday, time: `${parts.hour}:${parts.minute}` }
}
