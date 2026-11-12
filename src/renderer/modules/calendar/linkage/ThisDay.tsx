import { useEffect, useState } from 'react'
import type { DayInput, DaySummary } from '../../../../shared/calendar-linkage'
import { Button, RefCapsule } from '../../../components/ui'
import { attachDay } from './attachments'
/** What each kind of entry on a day is called (这一天, its quick look). */
export const DAY_ITEM_LABELS = { events: '日程', documents: '文档日期', tasks: '待办', reminders: '提醒', footprints: '阅读足迹', activity: '页面与画板' } as const
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
  return <section aria-label="这一天" className="this-day">
    <header><strong>这一天 · {date}</strong><Button size="sm" variant="ghost" disabled={!summary} onClick={async () => { try { await attachDay(summary!); setError('') } catch (cause) { setError(String(cause)) } }}>加入对话</Button></header>
    {error && <p role="alert">{error}</p>}
    {!summary && !error && <p role="status">正在读取…</p>}
    {summary?.items.length === 0 && <p>这一天还没有记录</p>}
    {/* Each entry is a reference capsule (W6 §2.1): click opens, ⌥-click or hover then Space quick-looks. */}
    {summary?.items.map(item => <div key={item.id} className="ready-calendar-agenda" data-day-item={item.kind}>
      <small>{DAY_ITEM_LABELS[item.kind]} · </small><RefCapsule reference={item.ref} title={item.title.replace(/\.(md|canvas)$/i, '')} />{item.detail && <small> · {item.detail}</small>}
    </div>)}
  </section>
}
