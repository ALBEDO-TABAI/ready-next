import { useEffect, useRef, useState } from 'react'
import type { RSSProcessingList, RSSProcessingSettings, RSSProcessingStatus } from '../../../shared/rss-processing'

const LABELS = { queued: '等待整理', running: '正在整理', success: '整理完成', failed: '结果未通过核对', unknown: '请求结果未知', canceled: '已取消', stale: '内容或标准已变化' }
export default function RSSProcessingPanel({ active, article }: { active: boolean; article?: { id: string; revision: string } }) {
  const [status, setStatus] = useState<RSSProcessingStatus | null>(null)
  const [list, setList] = useState<RSSProcessingList | null>(null)
  const [limit, setLimit] = useState('100'), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const identity = useRef(''), generation = useRef(0)
  const limitDirty = useRef(false)
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
    return () => { live = false; ++generation.current; off() }
  }, [active, article?.id, article?.revision])
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
  return <details className="rss-processing-panel">
    <summary>{article ? '本篇智能整理' : '自动整理'}{status ? ` · 待处理 ${status.pending} · 今日 ${status.callsToday}/${status.settings.dailyLimit} 次` : ''}</summary>
    {status && <>
      {!article && <div className="rss-processing-controls">
        <label><input type="checkbox" checked={status.settings.enabled} disabled={busy} onChange={(event) => void configure({ ...status.settings, enabled: event.target.checked })} />新增资讯自动分类与精选</label>
        <label>每日最多调用<input aria-label="每日整理调用上限" type="number" min="1" max="10000" value={limit} onChange={(event) => { limitDirty.current = true; setLimit(event.target.value) }} /></label>
        <button disabled={busy || !Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 10000} onClick={() => void configure({ ...status.settings, dailyLimit: Number(limit) }, true)}>保存限额</button>
        <button disabled={busy} onClick={() => void action(() => window.electronAPI.rss.resumeProcessing())}>继续待处理</button>
      </div>}
      <p>使用 Ready 当前模型，可能产生费用；失败和取消的已启动请求也计入限额。首次导入与历史文章不会自动重算。</p>
      {status.blocked && <p role="status">{status.blocked === 'model' ? '请先配置 Ready 模型，待处理内容已保留。' : status.blocked === 'limit' ? '今日已达到限额，待处理内容将于后续启动或刷新时继续。' : '自动整理已关闭；仍可手工整理本篇。'}</p>}
    </>}
    {article && <><p>本次范围：这篇文章，共 1 条。保留手工指定的归属。</p><button disabled={busy} onClick={() => void action(() => window.electronAPI.rss.reprocessArticle({ itemId: article.id, expectedArticleRevision: article.revision }))}>按当前标准整理本篇（使用模型）</button></>}
    {list && <ul>{list.jobs.map((job) => <li key={job.id}>
      {!article && <strong>{job.title}</strong>}
      <span>{job.definitions.map((definition) => definition.name).join('、')} · {LABELS[job.status]}</span>
      {job.message && job.message !== LABELS[job.status] && <small>{job.message}</small>}
      {['queued', 'running'].includes(job.status) && <button disabled={busy} onClick={() => void action(() => window.electronAPI.rss.cancelProcessing(job.id))}>取消</button>}
    </li>)}</ul>}
    {list?.nextOffset !== null && list?.nextOffset !== undefined && <button disabled={busy} onClick={() => { void refresh(true).catch((reason) => setError(String(reason))) }}>更多记录</button>}
    {error && <p role="alert">{error}</p>}
  </details>
}
