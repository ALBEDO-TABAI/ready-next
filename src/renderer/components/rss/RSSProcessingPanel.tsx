import { useEffect, useRef, useState } from 'react'
import type { RSSProcessingList, RSSProcessingSettings, RSSProcessingStatus } from '../../../shared/rss-processing'

const LABELS = { queued: '等待整理', running: '正在整理', success: '该次整理完成', failed: '结果未通过核对', unknown: '请求结果未知', canceled: '已取消', stale: '内容或标准已变化' }

// 自动整理状态：工作区里是页头状态行的一段安静链接，展开为玻璃浮层；
// 文章内是“分类与精选”里的一行折叠项。两处共用一份读取与操作逻辑。
export default function RSSProcessingPanel({ active, article }: { active: boolean; article?: { id: string; revision: string } }) {
  const [status, setStatus] = useState<RSSProcessingStatus | null>(null)
  const [list, setList] = useState<RSSProcessingList | null>(null)
  const [limit, setLimit] = useState('100'), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const identity = useRef(''), generation = useRef(0)
  const limitDirty = useRef(false)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  identity.current = `${active}:${article?.id || ''}:${article?.revision || ''}`
  const refresh = async (more = false) => {
    const key = identity.current, ticket = ++generation.current
    const [statusResult, jobsResult] = await Promise.all([window.electronAPI.rss.processingStatus(), window.electronAPI.rss.processingJobs({ itemId: article?.id, offset: more ? list?.nextOffset || 0 : 0, snapshot: more ? list?.snapshot : undefined })])
    if (key !== identity.current || ticket !== generation.current) return
    if (!statusResult.success || !statusResult.data || !jobsResult.success || !jobsResult.data) throw new Error(statusResult.error || jobsResult.error || '整理状态读取失败')
    setStatus(statusResult.data)
    if (!limitDirty.current) setLimit(String(statusResult.data.settings.dailyLimit))
    const next = jobsResult.data
    setList((previous) => ({ ...next, jobs: more && previous ? [...previous.jobs, ...next.jobs] : next.jobs }))
  }
  useEffect(() => {
    let live = true
    limitDirty.current = false
    setStatus(null); setList(null); setError(''); setBusy(false)
    if (!active) return
    const read = () => { void refresh().catch((reason) => { if (live) setError(String(reason)) }) }
    read(); const off = window.electronAPI.rss.onOrganizationChanged(read)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- generation is a counter bumped on cleanup to drop in-flight status reads; incrementing its live value is intended
    return () => { live = false; ++generation.current; off() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is recreated every render; the first-page refresh reads only article?.id, which this effect is keyed on, plus refs, so it must not resubscribe on each render
  }, [active, article?.id, article?.revision])
  // The workspace popover closes on an outside click, like the other RSS menus.
  useEffect(() => {
    if (article) return
    const close = (event: MouseEvent) => {
      const details = detailsRef.current
      if (details?.open && !details.contains(event.target as Node)) details.open = false
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [article])
  const action = async (run: () => Promise<{ success: boolean; error?: string }>) => {
    const key = identity.current; setBusy(true); setError('')
    try { const result = await run(); if (!result.success) throw new Error(result.error || '操作未完成'); if (key === identity.current) await refresh() }
    catch (reason) { if (key === identity.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (key === identity.current) setBusy(false) }
  }
  const configure = (value: RSSProcessingSettings, saveLimit = false) => action(async () => {
    const result = await window.electronAPI.rss.configureProcessing(value)
    if (result.success && saveLimit) limitDirty.current = false
    return result
  })
  const limitValid = Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 10000
  const summary = article
    ? `本篇智能整理${status ? ` · 今日 ${status.callsToday}/${status.settings.dailyLimit} 次` : ''}`
    : `自动整理${status ? `${status.pending ? ` · 待处理 ${status.pending}` : ''} · 今日 ${status.callsToday}/${status.settings.dailyLimit} 次` : ''}`
  const attention = !article && status && (status.blocked === 'model' || status.unresolved > 0)
  return <details ref={detailsRef} className={`rss-processing-panel ${article ? 'is-inline' : 'is-popover'}`}>
    <summary>{attention && <span className="rss-processing-panel__alert" aria-hidden="true" />}{summary}</summary>
    <div className="rss-processing-panel__body">
      {status && !article && <>
        <div className="rss-processing-panel__row">
          <div>
            <strong>新增资讯自动分类与精选</strong>
            <small>使用 Ready 当前模型，可能产生费用；首次导入与历史文章不会自动重算。</small>
          </div>
          <button type="button" role="switch" aria-checked={status.settings.enabled} aria-label="新增资讯自动分类与精选" className="sx-switch"
            data-checked={status.settings.enabled ? 'true' : 'false'} disabled={busy}
            onClick={() => void configure({ ...status.settings, enabled: !status.settings.enabled })} />
        </div>
        <div className="rss-processing-panel__row">
          <div>
            <strong>每日最多调用</strong>
            <small>失败和取消的已启动请求也计入限额。</small>
          </div>
          <div className="rss-processing-panel__limit">
            <input className="sx-input" aria-label="每日整理调用上限" type="number" min="1" max="10000" value={limit}
              onChange={(event) => { limitDirty.current = true; setLimit(event.target.value) }} />
            <button type="button" className="sx-btn sx-btn--sm" disabled={busy || !limitValid} onClick={() => void configure({ ...status.settings, dailyLimit: Number(limit) }, true)}>保存限额</button>
          </div>
        </div>
        {status.blocked && <p className="rss-note" role="status">{status.blocked === 'model' ? '请先配置 Ready 模型，待处理内容已保留。' : status.blocked === 'limit' ? '今日已达到限额，待处理内容将于后续启动或刷新时继续。' : '自动整理已关闭；仍可在文章里手工整理本篇。'}</p>}
        {status.pending > 0 && <button type="button" className="sx-btn sx-btn--sm" disabled={busy} onClick={() => void action(() => window.electronAPI.rss.resumeProcessing())}>继续待处理</button>}
        {status.unresolved > 0 && <div className="rss-processing-panel__row">
          <div>
            <strong>{status.unresolved} 篇整理失败或结果未知</strong>
            <small>不会自动重试。重新整理会按当前标准再次调用模型，并计入每日限额。</small>
          </div>
          <button type="button" className="sx-btn sx-btn--sm" disabled={busy} aria-label={`重新整理这 ${status.unresolved} 篇`}
            onClick={() => void action(() => window.electronAPI.rss.retryUnresolvedProcessing({ expectedCount: status.unresolved }))}>重新整理</button>
        </div>}
      </>}
      {article && <div className="rss-processing-panel__row">
        <div>
          <strong>按当前标准整理本篇</strong>
          <small>本次范围：这篇文章，共 1 条。保留手工指定的归属，会使用模型。</small>
        </div>
        <button type="button" className="sx-btn sx-btn--sm" disabled={busy} aria-label="按当前标准整理本篇（使用模型）"
          onClick={() => void action(() => window.electronAPI.rss.reprocessArticle({ itemId: article.id, expectedArticleRevision: article.revision }))}>整理本篇</button>
      </div>}
      {list && list.jobs.length > 0 && <ul className="rss-processing-panel__jobs">{list.jobs.map((job) => <li key={job.id} data-status={job.status}>
        <div className="rss-processing-panel__job">
          {!article && <strong title={job.title}>{job.title}</strong>}
          <span>{job.definitions.map((definition) => definition.name).join('、')} · {LABELS[job.status]}</span>
          {!job.inputCurrent && <small>历史版本或旧标准的记录，不代表当前结果。</small>}
          {job.status === 'success' && job.savedDecisionCount < job.definitions.length && <small>历史分类结果不完整或不可恢复；不会自动重新付费，可选择重新整理。</small>}
          {job.message && job.message !== LABELS[job.status] && <small>{job.message}</small>}
        </div>
        {['queued', 'running'].includes(job.status) && <button type="button" className="sx-btn sx-btn--ghost sx-btn--sm" disabled={busy} onClick={() => void action(() => window.electronAPI.rss.cancelProcessing(job.id))}>取消</button>}
      </li>)}</ul>}
      {list && list.jobs.length === 0 && <p className="rss-processing-panel__empty">还没有整理记录。</p>}
      {list?.nextOffset !== null && list?.nextOffset !== undefined && <button type="button" className="sx-btn sx-btn--ghost sx-btn--sm" disabled={busy} onClick={() => { void refresh(true).catch((reason) => setError(String(reason))) }}>更多记录</button>}
      {error && <p className="rss-note rss-note--danger" role="alert">{error}</p>}
    </div>
  </details>
}
