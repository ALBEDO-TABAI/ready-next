import { useEffect, useState } from 'react'
import type { DayInput, DaySummary } from '../../../../shared/calendar-linkage'
import { openReadyRef } from '../../workbench/open-ready-ref'
import { attachDay } from './attachments'
const labels = { events: '日程', documents: '文档日期', tasks: '待办', reminders: '提醒', footprints: '阅读足迹', activity: '页面与画板' }
export function ThisDay({ date, timeZone }: DayInput) {
  const [summary, setSummary] = useState<DaySummary | null>(null), [error, setError] = useState('')
  useEffect(() => {
    let disposed = false, revision = 0
    const refresh = async () => {
      const ticket = ++revision
      try { const value = await window.electronAPI.calendarLinkage.day({ date, timeZone }); if (!disposed && ticket === revision) { setSummary(value); setError('') } }
      catch (cause) { if (!disposed && ticket === revision) { setSummary(null); setError(String(cause)) } }
    }
    setSummary(null); setError('')
    const off = [window.electronAPI.canvas.onChanged(() => { void refresh() }), window.electronAPI.calendar.onChanged(() => { void refresh() }), window.electronAPI.calendarLayers.onChanged(() => { void refresh() }),
      window.electronAPI.dateMentions.onChanged(() => { void refresh() }), window.electronAPI.vault.onChanged(() => { setSummary(null); void refresh() })]
    void refresh()
    return () => { disposed = true; off.forEach(stop => stop()) }
  }, [date, timeZone])
  return <section aria-label="这一天" style={{ padding: 12, maxHeight: '35%', overflow: 'auto', flexShrink: 0 }}>
    <header><strong>这一天 · {date}</strong> <button className="btn sm" disabled={!summary} onClick={async () => { try { await attachDay(summary!); setError('') } catch (cause) { setError(String(cause)) } }}>加入对话</button></header>
    {error && <p role="alert">{error}</p>}
    {!summary && !error && <p role="status">正在读取…</p>}
    {summary?.items.length === 0 && <p>这一天还没有记录</p>}
    {summary?.items.map(item => <button key={item.id} className="ready-calendar-agenda" data-day-item={item.kind}
      onClick={() => void openReadyRef(item.ref, 'calendar').catch(cause => setError(String(cause)))}>
      <small>{labels[item.kind]} · </small>{item.title}{item.detail && ` · ${item.detail}`}
    </button>)}
  </section>
}
