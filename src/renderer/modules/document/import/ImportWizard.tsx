import { useEffect, useRef, useState } from 'react'
import type { DocumentImportAPI, ImportKind, ImportReport, ImportReply, ImportStatus, ImportLocation } from '../../../../shared/document-import'
import { ConnectedSaveToPicker } from '../page-ui/ConnectedSaveToPicker'
import type { SaveToPickerProps } from '../page-ui/SaveToPicker'
import { openReadyRef } from '../../workbench/open-ready-ref'

type Step = { kind: 'source' } | { kind: 'preview' | 'target' | 'confirm'; sourceId: string; report: ImportReport } | { kind: 'running'; id: string } | { kind: 'result'; status: ImportStatus }
const checked = <T,>(reply: ImportReply<T>): T => { if (!reply.ok) throw new Error(reply.message); return reply.value }
export function ImportWizard({ onClose, api = window.electronAPI.documentImport, Picker = ConnectedSaveToPicker, open = id => openReadyRef({ kind: 'page', id }, 'document') }: {
  onClose(): void; api?: DocumentImportAPI; Picker?: React.ComponentType<Omit<SaveToPickerProps, 'trees'>>; open?(id: string): Promise<unknown>
}) {
  const [step, setStep] = useState<Step>({ kind: 'source' }), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<ImportStatus[]>([]), [progress, setProgress] = useState<ImportStatus | null>(null)
  const lock = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; void api.list().then(reply => { if (alive.current) setHistory(checked(reply)) }).catch(error => { if (alive.current) setError(String(error)) }); return () => { alive.current = false } }, [api])
  useEffect(() => {
    if (step.kind !== 'running') return
    let stopped = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const reply = await api.status(step.id); if (!stopped && reply.ok) setProgress(reply.value) }
      catch (error) { if (!stopped) setError(String(error)) }
      if (!stopped) timer = setTimeout(() => { void poll() }, 300)
    }
    void poll(); return () => { stopped = true; clearTimeout(timer) }
  }, [api, step])
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await action() } catch (error) { if (alive.current) setError(String(error)) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const choose = (kind: ImportKind) => run(async () => {
    const source = checked(await api.choose(kind)); if (!source) return
    const report = checked(await api.preflight(source.sourceId)); setStep({ kind: 'preview', sourceId: source.sourceId, report })
  })
  const execute = (id: string, resume: boolean) => run(async () => {
    setStep({ kind: 'running', id }); setProgress(null)
    try { const status = checked(await (resume ? api.resume(id) : api.execute(id))); if (alive.current) setStep({ kind: 'result', status }) }
    catch (error) { if (alive.current) setStep({ kind: 'source' }); throw error }
  })
  const issues = step.kind === 'result' ? step.status.issues : 'report' in step ? step.report.issues : []
  return <section role="dialog" aria-label="导入 Notion / Inkwell" className="fixed inset-8 z-50 overflow-auto rounded-xl border bg-[var(--bg-primary)] p-5 shadow-xl">
    <div className="flex justify-between"><h2>导入 Notion / Inkwell</h2><button disabled={busy} onClick={onClose}>关闭</button></div>
    {error && <p role="alert">{error}</p>}
    {step.kind === 'source' && <><p>选择 Notion 的 Markdown & CSV 导出包，或 Inkwell 工作区 JSON 备份。来源文件只读。</p>
      <button disabled={busy} onClick={() => void choose('notion')}>选择 Notion ZIP</button><button disabled={busy} onClick={() => void choose('inkwell')}>选择 Inkwell JSON</button>
      {history.map(item => <div key={item.id}><span>{item.results[0]?.path ?? '待继续的导入'} · {item.done}/{item.total}</span><button disabled={busy} onClick={() => void execute(item.id, true)}>{['completed', 'incomplete'].includes(item.state) ? '核对结果' : '继续导入'}</button></div>)}
    </>}
    {'report' in step && <><p>{step.report.sourceName}：{step.report.counts.pages} 页，{step.report.counts.databases} 个库，{step.report.counts.rows} 行，{step.report.counts.attachments} 个附件</p>
      <details><summary>查看页面映射</summary>{step.report.pages.map(page => <p key={page.source}>{page.source} → {page.path}</p>)}</details>
    </>}
    {issues.length > 0 && <section aria-label="缺失与注意事项"><h3>缺失与注意事项</h3><ul>{issues.map((issue, index) => <li key={index}>{issue.item}：{issue.message}</li>)}</ul></section>}
    {step.kind === 'preview' && <button onClick={() => setStep({ ...step, kind: 'target' })}>选择导入位置</button>}
    {step.kind === 'target' && <Picker initialTitle="导入资料" onCancel={() => setStep(current => current.kind === 'target' ? { ...current, kind: 'preview' } : current)} onConfirm={async selection => {
      try {
        const target: ImportLocation = { parentPath: selection.parentPath, parentObjectId: selection.parentObjectId, title: selection.title }
        const report = checked(await api.preflight(step.sourceId, target))
        setStep({ kind: 'confirm', sourceId: step.sourceId, report }); return { ok: true, value: report }
      } catch (error) { return { ok: false, code: 'import_failed', message: String(error) } }
    }} />}
    {step.kind === 'confirm' && <><p>目标：{step.report.target?.parentPath}/{step.report.target?.title}</p><button onClick={() => setStep({ ...step, kind: 'target' })}>更换位置</button><button disabled={busy || step.report.issues.some(issue => issue.kind === 'conflict')} onClick={() => void execute(step.report.id, false)}>开始导入</button></>}
    {step.kind === 'running' && <p role="status">正在导入：{progress?.done ?? 0}/{progress?.total ?? '…'}，可以在中断后继续。</p>}
    {step.kind === 'result' && <><p role="status">{step.status.state === 'completed' ? '导入完成，已逐项核对。' : step.status.state === 'incomplete' ? '导入结束，但有缺失或未支持的内容，请查看清单。' : '导入中断，可以继续。'}</p>
      {step.status.error && <p role="alert">{step.status.error}</p>}
      {step.status.state === 'interrupted' && <button disabled={busy} onClick={() => void execute(step.status.id, true)}>继续导入</button>}
      {step.status.results.map(item => <button key={item.objectId} disabled={busy} onClick={() => void run(async () => { await open(item.objectId) })}>打开{item.database ? '数据库' : '页面'}：{item.path.split('/').pop()}</button>)}
    </>}
  </section>
}
