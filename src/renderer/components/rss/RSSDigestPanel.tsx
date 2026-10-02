import { useEffect, useRef, useState } from 'react'
import type { RSSDigestHeader, RSSDigestEntry, RSSDigestSource, RSSDigestCoverageSource, RSSDigestScheduleState, RSSDigestCriteria } from '../../../shared/rss-digests'
import type { RSSQueryResult } from '../../../shared/rss-workspace'
import { useRSSSession } from '../../stores/useRSSSession'
import { toRSSItem } from '../../modules/rss/workspace-query'
import type { RSSItem } from './RSSFeed'
import RSSReferenceButton from './RSSReferenceButton'
import { openWebpageInBrowser } from '../../modules/browser/openWebpageInBrowser'

const time = (value: number, timezone: string) => new Date(value).toLocaleString(undefined, { timeZone: timezone })
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
    <button onClick={() => { setOpen(!open); if (!open && !busy && rows.length === 0 && next !== null) void read() }} aria-expanded={open}>{groupKey ? '查看全部报道依据' : criteria ? '查看本刊采用的标准版本' : '查看订阅覆盖与采集情况'}</button>
    {open && <>
      {rows.map((row) => 'itemId' in row ? <div key={`${row.itemId}:${row.articleRevision}`}>
        <strong>{row.source} · {row.title}</strong><blockquote>{row.quote}</blockquote>
        <p>{row.quoteKind === 'source_summary' ? '来源摘要' : row.quoteKind === 'title' ? '仅有标题' : '原文摘句'}{row.quoteTruncated ? ' · 节选' : ''} · {row.bodyStatus === 'ready' ? '已保存正文' : '正文不完整或尚未获取'}</p>
        {row.curation && <p>{row.curation.origin === 'manual' ? '手工精选' : '模型精选理由'}：{row.curation.reason}</p>}
        <button onClick={() => onRead(row)}>阅读对应版本</button>
        <button onClick={() => void openWebpageInBrowser(row.link)}>打开原网站</button>
      </div> : 'ruleRevision' in row ? <div key={row.id}><strong>{row.name} · 标准第 {row.ruleRevision} 版</strong><p>{row.description}</p></div> : <div key={row.id}><strong>{row.name}</strong><p>{row.enabled ? '已启用' : '已停用'} · {row.fetch ? `${row.fetch.attemptedAt} · ${row.fetch.success ? '最近采集成功' : '最近采集失败'}` : '缺少最近采集结果'}{row.fetch?.error ? ` · ${row.fetch.error}` : ''}{row.fetch?.warning ? ` · ${row.fetch.warning}` : ''}</p></div>)}
      {next !== null && <button disabled={busy} onClick={() => void read()}>{busy ? '读取中…' : '继续读取依据'}</button>}
      {error && <p role="alert">{error}</p>}
    </>}
  </div>
}

export default function RSSDigestPanel({ active, view, onReadArticle }: { active: boolean; view: RSSQueryResult | null; onReadArticle(item: RSSItem): void }) {
  const selected = useRSSSession((s) => s.selectedDigestId), setDigestView = useRSSSession((s) => s.setDigestView)
  const [editions, setEditions] = useState<RSSDigestHeader[]>([]), [editionNext, setEditionNext] = useState<number | null>(null), [snapshot, setSnapshot] = useState<number>()
  const [report, setReport] = useState<RSSDigestHeader | null>(null), [entries, setEntries] = useState<RSSDigestEntry[]>([]), [next, setNext] = useState<number | null>(null)
  const [settings, setSettings] = useState<RSSDigestScheduleState | null>(null), [draftTime, setDraftTime] = useState('08:00')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const listTicket = useRef(0), readTicket = useRef(0), actionTicket = useRef(0), dirtyTime = useRef(false)
  const list = async (more = false) => {
    const ticket = ++listTicket.current
    const result = await window.electronAPI.rss.readDigests({ offset: more ? editionNext ?? 0 : 0, snapshot: more ? snapshot : undefined })
    if (ticket !== listTicket.current) return
    if (!result.success || result.data?.view !== 'editions') throw new Error(result.error || '刊物目录读取失败')
    const data = result.data; setEditions((old) => more ? [...old, ...data.editions] : data.editions); setEditionNext(data.nextOffset); setSnapshot(data.snapshot)
  }
  const read = async (id: string, more = false) => {
    const ticket = ++readTicket.current
    const result = await window.electronAPI.rss.readDigests({ view: 'entries', reportId: id, offset: more ? next ?? 0 : 0 })
    if (ticket !== readTicket.current || useRSSSession.getState().selectedDigestId !== id) return
    if (!result.success || result.data?.view !== 'entries') throw new Error(result.error || '刊物读取失败')
    const data = result.data; setReport(data.report); setEntries((old) => more ? [...old, ...data.entries] : data.entries); setNext(data.nextOffset)
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
    ++actionTicket.current; setBusy(false); setReport(null); setEntries([]); setNext(null); setError(''); setNotice('')
    if (!active || !selected) return
    void read(selected).catch((e) => setError(String(e)))
    return () => { ++readTicket.current }
  }, [selected, active])
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
  return <section className="rss-digest-panel" aria-label="日报与简报">
    <header className="glass-surface-floating"><h2>日报与简报</h2><button disabled={busy || !view} onClick={() => void action(() => generate('range'))}>生成当前筛选范围简报</button></header>
    <details className="rss-processing-panel"><summary>日报时间与覆盖</summary>
      <p>按本机时区每天生成；关闭或休眠后补最近一期。不会自动发送到外部，也不会再次调用模型扩写新闻。</p>
      {settings && <><label><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={(e) => void action(async () => {
        const result = await window.electronAPI.rss.configureDigests({ enabled: e.target.checked, localTime: settings.localTime }); if (!result.success || !result.data) throw new Error(result.error); setSettings(result.data)
      })} />自动生成日报</label><label>当地时间<input type="time" value={draftTime} onChange={(e) => { dirtyTime.current = true; setDraftTime(e.target.value) }} /></label>
        <button disabled={busy || !draftTime} onClick={() => void action(async () => { const result = await window.electronAPI.rss.configureDigests({ enabled: settings.enabled, localTime: draftTime }); if (!result.success || !result.data) throw new Error(result.error); setSettings(result.data); dirtyTime.current = false })}>保存日报时间</button>
        <p>{settings.timezone} · 下次：{settings.enabled && settings.nextRunAt ? new Date(settings.nextRunAt).toLocaleString() : '已关闭'}</p>{settings.error && <p role="alert">上次生成未完成：{settings.error}。会在下次启动、恢复或定时触发时重试。</p>}</>}
    </details>
    <nav className="rss-digest-editions" aria-label="已保存刊物">{editions.map((edition) => <button key={edition.id} aria-current={selected === edition.id ? 'page' : undefined} onClick={() => setDigestView(true, edition.id)}>{edition.kind === 'daily' ? '日报' : '范围简报'} · {time(edition.until, edition.timezone)} · 第 {edition.version} 版 · {edition.total} 项{edition.needsUpdate ? ' · 需更新' : ''}</button>)}
      {!editions.length && <p>尚无已保存刊物。</p>}{editionNext !== null && <button onClick={() => void action(() => list(true))}>更早刊物</button>}</nav>
    {report && <article className="rss-digest-content">
      <h1>{report.kind === 'daily' ? '资讯日报' : '当前范围简报'} · 第 {report.version} 版</h1>
      <p>{report.kind === 'daily' ? `${time(report.from, report.timezone)} 至 ${time(report.until, report.timezone)}（不含截止时刻） · ` : ''}{report.scopeLabel} · {report.timezone} · 生成于 {time(report.createdAt, report.timezone)}</p>
      <p>{report.total} 项 · {report.referenceCount} 条报道依据；未得明确精选判断 {report.coverage.unresolvedArticles} 篇，其中有失败或未知任务 {report.coverage.failedArticles} 篇；等待整理 {report.coverage.pendingArticles} 篇。正文不完整或缺失 {report.coverage.missingBodies} 篇，补收 {report.coverage.carriedOverArticles} 篇。</p>
      {report.needsUpdate && <p role="status">来源、标准或归属已经变化；这里保留发布时的内容，可重新生成新版本。</p>}
      <div className="rss-reader-actions"><RSSReferenceButton name={`${report.kind === 'daily' ? '日报' : '范围简报'} 第 ${report.version} 版`} label="引用本刊" reference={{ kind: 'digest', read: { reportId: report.id, offset: 0, limit: 20 } }} />
        <button disabled={busy} onClick={() => void action(() => generate('regenerate'))}>重新生成新版本</button>
        <button disabled={busy} onClick={() => void action(async () => { const ticket = actionTicket.current; const result = await window.electronAPI.rss.exportDigest({ reportId: report.id }); if (!result.success || !result.data) throw new Error(result.error); if (ticket === actionTicket.current) setNotice(result.data.canceled ? '已取消导出' : `已导出：${result.data.path}`) })}>导出本刊</button></div>
      <Sources key={`${report.id}:criteria`} reportId={report.id} criteria onRead={readArticle} />
      <Sources key={`${report.id}:coverage`} reportId={report.id} onRead={readArticle} />
      {!report.total && <p>本期暂无已入选的可用内容，不代表没有新闻。</p>}
      {entries.map((entry, index) => <section key={entry.groupKey}>{(index === 0 || entries[index - 1].section !== entry.section) && <h2>{entry.section}</h2>}<div className="rss-digest-entry"><p>{entry.source.topics.map((topic) => topic.name).join(' · ') || '未分类'}</p>
        <h2>{entry.source.title}</h2><blockquote>{entry.source.quote}</blockquote><p>{entry.source.source} · {entry.source.quoteKind === 'source_summary' ? '来源摘要' : entry.source.quoteKind === 'title' ? '仅标题' : '原文摘句'}{entry.source.quoteTruncated ? ' · 节选' : ''} · 共 {entry.referenceCount} 条依据</p>
        {entry.source.curation && <p>{entry.source.curation.origin === 'manual' ? '手工精选' : '模型精选理由'}：{entry.source.curation.reason}</p>}
        <Sources key={`${report.id}:${entry.groupKey}`} reportId={report.id} groupKey={entry.groupKey} onRead={readArticle} /></div></section>)}
      {next !== null && <button disabled={busy} onClick={() => void action(() => read(report.id, true))}>更多条目</button>}
    </article>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
