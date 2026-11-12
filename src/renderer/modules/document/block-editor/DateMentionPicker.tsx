import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ReadyRefSchema } from '../../../../shared/ready-ref'
import type { DateMentionRef } from '../../../../shared/calendar/date-mentions'
import type { MenuAnchor } from './CommandMenu'

export function DateMentionPicker({ value, anchor, save, close, open, report }: {
  value: DateMentionRef; anchor: MenuAnchor; save(ref: DateMentionRef): void; close(): void
  open(): Promise<unknown>; report(error: unknown): void
}) {
  const [date, setDate] = useState(value.date), [at, setAt] = useState(value.at ?? '')
  const [remind, setRemind] = useState(value.remind === undefined ? '' : String(value.remind))
  return createPortal(<form data-block-popup data-ready-native-overlay="" role="dialog" aria-label="日期与提醒"
    style={{ position: 'fixed', zIndex: 1000, left: anchor.left, top: anchor.bottom, padding: 12, background: 'var(--rn-sheet)', border: '1px solid var(--rn-hair-2)', borderRadius: 12 }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') close() }}
    onSubmit={event => {
      event.preventDefault()
      try {
        const ref = ReadyRefSchema.parse({ kind: 'day', date, ...(at ? { at } : {}), ...(remind !== '' ? { remind: Number(remind) } : {}) })
        if (ref.kind === 'day') save(ref)
      } catch (error) { console.warn('[DateMentionPicker] save date mention failed:', error instanceof Error ? error.message : String(error)); report(error) }
    }}>
    <label>日期<input aria-label="日期" type="date" required value={date} onChange={event => setDate(event.target.value)} /></label>
    <label>时间<input aria-label="时间" type="time" value={at} onChange={event => setAt(event.target.value)} /></label>
    <label>提前分钟<input aria-label="提前分钟" type="number" min="0" step="1" value={remind} placeholder="不提醒" onChange={event => setRemind(event.target.value)} /></label>
    <p>不填时间时按当天 09:00；留空提前分钟则不提醒。保存文档后生效。</p>
    <button type="submit">应用</button>
    <button type="button" onClick={() => { void open().catch(report) }}>打开日历</button>
    <button type="button" onClick={close}>取消</button>
  </form>, document.body)
}
