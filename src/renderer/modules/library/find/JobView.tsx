import { useEffect, useState } from 'react'
import type { BookSourcesAPI, SourceJob } from '../../../../shared/library-sources'
import { confirmed } from '../access'
const labels = { queued: '排队中', downloading: '下载中', captcha: '需要验证码', extracting: '解压、上架中', done: '已上架', failed: '下载失败', cancelled: '已取消' }
function JobLine({ job, api }: { job: SourceJob; api: BookSourcesAPI }) {
  const [answer, setAnswer] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { setAnswer('') }, [job.captcha?.token])
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await work() } catch (error) { setError(String(error)) } finally { setBusy(false) }
  }
  return <article className="source-job" aria-label={`下载任务 ${job.ref}`}>
    <div><strong>{job.ref}</strong><span>{job.message || labels[job.status]}</span><progress aria-label="下载进度" max={100} value={job.status === 'downloading' && job.progress === 0 ? undefined : job.progress} /></div>
    {job.error && <p role="alert">{job.error}</p>}
    {job.captcha && <form onSubmit={e => { e.preventDefault(); const captcha = job.captcha; if (captcha) void run(async () => confirmed(await api.answer({ id: job.id, token: captcha.token, text: answer }))) }}>
      <img alt="网盘验证码" src={job.captcha.image} /><input aria-label="验证码" value={answer} maxLength={16} onChange={e => setAnswer(e.target.value)} /><button disabled={busy || !answer.trim()}>提交验证码</button>
    </form>}
    {['queued', 'downloading', 'captcha', 'extracting'].includes(job.status) && <button type="button" disabled={busy} onClick={() => void run(async () => confirmed(await api.cancel(job.id)))}>取消</button>}
    {['failed', 'cancelled'].includes(job.status) && !job.book_id && <button type="button" disabled={busy} onClick={() => void run(async () => confirmed(await api.retry(job.id)))}>重试下载</button>}
    {job.status === 'failed' && job.source !== 'zlib' && <button type="button" disabled={busy} onClick={() => void run(async () => confirmed(await api.openManual(job.id)))}>去网盘手动下载</button>}
    {error && <p role="alert">{error}</p>}
  </article>
}
export function JobView({ api }: { api: BookSourcesAPI }) {
  const [jobs, setJobs] = useState<SourceJob[]>([]), [error, setError] = useState('')
  useEffect(() => {
    let live = true, pushed = false
    const off = api.onChanged(jobs => { pushed = true; if (live) setJobs(jobs) })
    api.jobs().then(confirmed).then(jobs => { if (live && !pushed) setJobs(jobs) }).catch(error => { if (live) setError(String(error)) })
    return () => { live = false; off() }
  }, [api])
  return <aside className="source-jobs" aria-label="下载任务">{error && <p role="alert">{error}</p>}{jobs.map(job => <JobLine key={job.id} job={job} api={api} />)}</aside>
}
