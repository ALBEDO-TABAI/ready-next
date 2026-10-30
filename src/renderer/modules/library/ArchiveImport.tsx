import { useEffect, useRef, useState } from 'react'
import type { LibraryArchiveAPI, LibraryArchiveProgress, LibraryArchiveReport } from '../../../shared/library'
import { confirmed } from './access'

type View = { kind: 'closed' } | { kind: 'choose'; suggestion: string } |
  { kind: 'running'; progress: LibraryArchiveProgress | null } | { kind: 'report'; report: LibraryArchiveReport }

export function ArchiveImport({ api, disabled, onBusy }: { api: LibraryArchiveAPI; disabled: boolean; onBusy(value: boolean): void }) {
  const [view, setView] = useState<View>({ kind: 'closed' }), [error, setError] = useState('')
  const active = useRef(false)
  useEffect(() => api.onArchiveProgress(progress => {
    if (active.current) setView({ kind: 'running', progress })
  }), [api])
  const open = async () => {
    setError('')
    try { setView({ kind: 'choose', suggestion: confirmed(await api.archiveSuggestion()) }) }
    catch (error) { setView({ kind: 'choose', suggestion: '' }); setError(String(error)) }
  }
  const run = async () => {
    if (active.current || view.kind !== 'choose') return
    const previous = view
    active.current = true; onBusy(true); setError(''); setView({ kind: 'running', progress: null })
    try {
      const report = confirmed(await api.pickAndImportArchive())
      setView(report ? { kind: 'report', report } : previous)
    } catch (error) { setView(previous); setError(String(error)) }
    finally { active.current = false; onBusy(false) }
  }
  return <>
    <button type="button" disabled={disabled || view.kind === 'running'} onClick={() => void open()}>从藏书阁导入…</button>
    {view.kind !== 'closed' && <div className="archive-backdrop"><section className="archive-dialog" role="dialog" aria-modal="true" aria-label="从藏书阁导入">
      <h2>从藏书阁导入</h2>
      {error && <p role="alert">{error}</p>}
      {view.kind === 'choose' && <>
        <p>选择包含 library.json、files 和 covers 的数据目录。原目录保持不变。</p>
        {view.suggestion && <p>桌面版建议位置（不会自动读取）：<code>{view.suggestion}</code></p>}
        <button type="button" onClick={() => void run()}>选择目录并导入</button>
      </>}
      {view.kind === 'running' && <div role="status">
        <p>{view.progress ? `正在导入 ${view.progress.completed} / ${view.progress.total}：${view.progress.title}` : '等待选择目录和确认…'}</p>
        <progress aria-label="藏书阁导入进度" max={view.progress?.total || 1} value={view.progress?.completed} />
      </div>}
      {view.kind === 'report' && <>
        <p role="status">导入结束：成功 {view.report.success.length} 本，跳过 {view.report.skipped.length} 本，失败 {view.report.failed.length} 本；未定位划线 {view.report.unlocated} 条。</p>
        {view.report.failed.length > 0 && <details><summary>查看失败项</summary><ul>{view.report.failed.map(item => <li key={item.id}>{item.title}：{item.reason}</li>)}</ul></details>}
        {view.report.skipped.length > 0 && <details><summary>查看跳过项</summary><ul>{view.report.skipped.map(item => <li key={item.id}>{item.title}：{item.reason}</li>)}</ul></details>}
      </>}
      {view.kind !== 'running' && <button type="button" onClick={() => setView({ kind: 'closed' })}>关闭</button>}
    </section></div>}
  </>
}
