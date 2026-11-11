import { useState } from 'react'
import { api, unwrap } from '../platform'
import { reload } from '../store'

// 迁入 (W4 §4): the one-time move from the standalone calendar app lives in 设置 › 日历, not in the sidebar.
// The original data file is only read; events already moved in are neither repeated nor overwritten.
type Preview = { ticket: string; fileName: string; calendars: number; events: number; possibleExamples: number }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function StandaloneImport() {
  const [preview, setPreview] = useState<Preview | null>(null), [skipExamples, setSkipExamples] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState('')
  const choose = async () => {
    setError(''); setDone('')
    try { const next = await unwrap(api().prepareStandaloneImport()); setPreview(next ?? null); setSkipExamples(false) }
    catch (cause) { setError(message(cause)) }
  }
  const apply = async () => {
    if (!preview || busy) return
    setBusy(true); setError('')
    try {
      const result = await unwrap(api().applyStandaloneImport(preview.ticket, skipExamples))
      await reload(); setPreview(null)
      setDone(`已迁入 ${result.created} 条日程，跳过 ${result.skipped} 条已存在的记录。`)
    } catch (cause) { setError(message(cause)) }
    finally { setBusy(false) }
  }
  return <section className="calendar-migrate" aria-label="从独立日历迁入">
    <h3>从独立日历迁入</h3>
    <p>把独立日历应用的数据文件迁入 Ready 本地日程。只读取原文件；已经迁入的日程不会重复，也不会被覆盖。</p>
    {!preview && <button type="button" className="btn" onClick={() => void choose()}>选择数据文件…</button>}
    {preview && <div className="calendar-migrate-preview">
      <p>{preview.fileName}：{preview.calendars} 个分类，{preview.events} 条日程。</p>
      {preview.possibleExamples > 0 && <label><input type="checkbox" checked={skipExamples} onChange={event => setSkipExamples(event.target.checked)} /> 跳过与内置示例同名且未修改的 {preview.possibleExamples} 条日程</label>}
      <div className="calendar-migrate-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => setPreview(null)}>取消</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void apply()}>确认迁入</button>
      </div>
    </div>}
    {done && <p role="status">{done}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
