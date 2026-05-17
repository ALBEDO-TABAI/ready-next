import { useState } from 'react'
import { Bell, X, Plus } from 'lucide-react'
import type { Reminder } from '../../../shared/calendar-types'

/**
 * Hard cap matches IPC zod expectations (per L2-A reminder-codec):
 * offsets are bounded so a bogus huge value cannot create a timer
 * absurdly far in the future. 30 days = 43200 minutes.
 */
const MAX_OFFSET_MAGNITUDE_MINUTES = 30 * 24 * 60

/**
 * Preset offsets surfaced as a quick-pick row in the editor. Values are
 * stored as negative minutes (before event start). `0` means "at start".
 *
 * Custom offsets fall back to the inline numeric input + before/after
 * toggle below the preset row.
 */
const PRESET_OFFSETS: { label: string; offsetMinutes: number }[] = [
  { label: '开始时', offsetMinutes: 0 },
  { label: '5 分钟前', offsetMinutes: -5 },
  { label: '15 分钟前', offsetMinutes: -15 },
  { label: '30 分钟前', offsetMinutes: -30 },
  { label: '1 小时前', offsetMinutes: -60 },
  { label: '1 天前', offsetMinutes: -1440 },
]

const DEFAULT_REMINDER: Reminder = { offsetMinutes: -15, method: 'notification' }

export interface ReminderEditorProps {
  value: Reminder[] | null
  onChange: (next: Reminder[] | null) => void
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--text-muted)',
  marginBottom: 4,
  display: 'block',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid var(--input-slot-border)',
  background: 'var(--input-slot-bg)',
  boxShadow: 'var(--input-slot-shadow)',
  height: 32,
  fontSize: 12,
  color: 'var(--text-body)',
}

const presetButtonStyle = (selected: boolean): React.CSSProperties => ({
  fontSize: 10,
  padding: '3px 8px',
  borderRadius: 6,
  border: `1px solid ${selected ? 'var(--color-blue)' : 'var(--border-default)'}`,
  background: selected ? 'var(--color-blue-light)' : 'transparent',
  color: selected ? 'var(--color-blue)' : 'var(--text-body)',
  cursor: 'pointer',
  transition: 'background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease',
})

/**
 * Format an offset back into the dropdown preset value, or `'custom'`
 * if it doesn't match any preset.
 */
function offsetToPresetKey(offsetMinutes: number): string {
  const preset = PRESET_OFFSETS.find((p) => p.offsetMinutes === offsetMinutes)
  return preset ? String(preset.offsetMinutes) : 'custom'
}

/**
 * Round + clamp offsetMinutes to an integer in
 * [-MAX_OFFSET_MAGNITUDE_MINUTES, MAX_OFFSET_MAGNITUDE_MINUTES].
 *
 * Exported for tests — encapsulates the integer / clamp contract so
 * `parseRemindersInput` on the main side never rejects what this UI
 * produces. (zod schema in L2-A is `.int()` so non-integer offsets are
 * rejected at IPC boundary.)
 */
export function normalizeOffsetMinutes(raw: number): number {
  if (!Number.isFinite(raw)) return 0
  const rounded = Math.round(raw)
  if (rounded > MAX_OFFSET_MAGNITUDE_MINUTES) return MAX_OFFSET_MAGNITUDE_MINUTES
  if (rounded < -MAX_OFFSET_MAGNITUDE_MINUTES) return -MAX_OFFSET_MAGNITUDE_MINUTES
  return rounded
}

/**
 * Convert any input (possibly empty) into the canonical IPC contract:
 * null when there are 0 reminders, otherwise the original array. The
 * IPC layer treats `undefined` as "no-op" and `null` as "clear" — for a
 * controlled editor we always pass the explicit value to `onChange`.
 *
 * Exported for tests.
 */
export function canonicalizeReminderList(list: Reminder[]): Reminder[] | null {
  if (list.length === 0) return null
  return list.map((r) => ({
    offsetMinutes: normalizeOffsetMinutes(r.offsetMinutes),
    method: r.method,
  }))
}

export default function ReminderEditor({ value, onChange }: ReminderEditorProps) {
  // Local UI state tracks the "custom mode" toggle per-row. We need it
  // because flipping select → 'custom' should reveal the numeric input
  // even before the user types a value (otherwise the row collapses
  // back to the closest preset).
  const [customRows, setCustomRows] = useState<Set<number>>(new Set())

  const reminders = value ?? []

  const updateRow = (index: number, patch: Partial<Reminder>) => {
    const next = reminders.map((r, i) => (i === index ? { ...r, ...patch } : r))
    onChange(canonicalizeReminderList(next))
  }

  const removeRow = (index: number) => {
    const next = reminders.filter((_, i) => i !== index)
    setCustomRows((prev) => {
      const out = new Set<number>()
      for (const i of prev) {
        if (i < index) out.add(i)
        else if (i > index) out.add(i - 1)
      }
      return out
    })
    onChange(canonicalizeReminderList(next))
  }

  const addRow = () => {
    onChange(canonicalizeReminderList([...reminders, DEFAULT_REMINDER]))
  }

  const handlePresetChange = (index: number, presetKey: string) => {
    if (presetKey === 'custom') {
      setCustomRows((prev) => new Set(prev).add(index))
      return
    }
    const minutes = Number.parseInt(presetKey, 10)
    if (!Number.isFinite(minutes)) return
    setCustomRows((prev) => {
      if (!prev.has(index)) return prev
      const next = new Set(prev)
      next.delete(index)
      return next
    })
    updateRow(index, { offsetMinutes: minutes })
  }

  return (
    <div>
      <span style={labelStyle}>提醒</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {reminders.map((reminder, index) => {
          const presetKey = customRows.has(index) ? 'custom' : offsetToPresetKey(reminder.offsetMinutes)
          const isCustom = presetKey === 'custom'
          const isBeforeStart = reminder.offsetMinutes < 0
          return (
            <div key={index} style={rowStyle}>
              <Bell style={{ width: 12, height: 12, color: 'var(--text-muted)', flexShrink: 0 }} strokeWidth={2} />
              <select
                value={presetKey}
                onChange={(e) => handlePresetChange(index, e.target.value)}
                aria-label="提醒偏移"
                style={{
                  border: 'none',
                  background: 'transparent',
                  fontSize: 11,
                  color: 'var(--text-body)',
                  outline: 'none',
                  padding: 0,
                  minWidth: 70,
                  fontFamily: 'Inter, system-ui, sans-serif',
                }}
              >
                {PRESET_OFFSETS.map((p) => (
                  <option key={p.offsetMinutes} value={p.offsetMinutes}>{p.label}</option>
                ))}
                <option value="custom">自定义</option>
              </select>

              {isCustom && (
                <>
                  <input
                    type="number"
                    aria-label="自定义偏移分钟数"
                    value={Math.abs(reminder.offsetMinutes)}
                    min={0}
                    max={MAX_OFFSET_MAGNITUDE_MINUTES}
                    onChange={(e) => {
                      const magnitude = Number.parseFloat(e.target.value || '0')
                      if (!Number.isFinite(magnitude)) return
                      const signed = isBeforeStart ? -Math.abs(magnitude) : Math.abs(magnitude)
                      updateRow(index, { offsetMinutes: normalizeOffsetMinutes(signed) })
                    }}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      fontSize: 11,
                      color: 'var(--text-body)',
                      outline: 'none',
                      width: 60,
                      padding: 0,
                      fontFamily: 'Inter, system-ui, sans-serif',
                    }}
                  />
                  <select
                    aria-label="自定义偏移方向"
                    value={isBeforeStart || reminder.offsetMinutes === 0 ? 'before' : 'after'}
                    onChange={(e) => {
                      const dir = e.target.value === 'before' ? -1 : 1
                      const magnitude = Math.abs(reminder.offsetMinutes)
                      updateRow(index, {
                        offsetMinutes: normalizeOffsetMinutes(dir * magnitude),
                      })
                    }}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      fontSize: 10,
                      color: 'var(--text-muted)',
                      outline: 'none',
                      padding: 0,
                      fontFamily: 'Inter, system-ui, sans-serif',
                    }}
                  >
                    <option value="before">分钟前</option>
                    <option value="after">分钟后</option>
                  </select>
                </>
              )}

              <span style={{ flex: 1 }} />

              {/* method toggle: notification ↔ sound. Compact chip pair
                  so the row stays single-line. */}
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  onClick={() => updateRow(index, { method: 'notification' })}
                  aria-pressed={reminder.method === 'notification'}
                  style={presetButtonStyle(reminder.method === 'notification')}
                >
                  通知
                </button>
                <button
                  type="button"
                  onClick={() => updateRow(index, { method: 'sound' })}
                  aria-pressed={reminder.method === 'sound'}
                  style={presetButtonStyle(reminder.method === 'sound')}
                >
                  声音
                </button>
              </div>

              <button
                type="button"
                onClick={() => removeRow(index)}
                aria-label="删除提醒"
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  padding: 2,
                  display: 'flex',
                  alignItems: 'center',
                  borderRadius: 4,
                  color: 'var(--text-muted)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <X style={{ width: 12, height: 12 }} strokeWidth={2} />
              </button>
            </div>
          )
        })}

        <button
          type="button"
          onClick={addRow}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            alignSelf: 'flex-start',
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px dashed var(--border-default)',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: 11,
            cursor: 'pointer',
            transition: 'background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--color-blue)'
            e.currentTarget.style.borderColor = 'var(--color-blue)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-muted)'
            e.currentTarget.style.borderColor = 'var(--border-default)'
          }}
        >
          <Plus style={{ width: 11, height: 11 }} strokeWidth={2} />
          添加提醒
        </button>
      </div>
    </div>
  )
}
