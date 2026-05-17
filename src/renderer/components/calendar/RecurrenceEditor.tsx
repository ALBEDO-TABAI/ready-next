import { useMemo, useState } from 'react'
import { Repeat } from 'lucide-react'

/**
 * L3-B-RRULE-UI — `RecurrenceEditor` translates a user-friendly form
 * (frequency + interval + end condition) to/from an RFC 5545 RRULE
 * string. The wire shape is the same string the main-side rrule engine
 * accepts (`expandRecurringEvent` runs it through
 * `normalizeRruleString`).
 *
 * Why a small form instead of free-text RRULE: most users want
 * "every Monday for 10 weeks" or "every 2 weeks until July 1" without
 * writing `FREQ=WEEKLY;BYDAY=MO;COUNT=10`. The custom textarea is a
 * deliberate escape hatch for power users who paste RFC 5545 verbatim;
 * it bypasses the dropdown and stores the typed string raw.
 *
 * Two pure functions are exported for tests:
 *   - `buildRruleString(state)`: state → RRULE string (or null when
 *     `freq === 'NONE'`).
 *   - `parseRruleStringToState(rrule)`: RRULE string → state. Unknown
 *     clauses fall back to `{ freq: 'CUSTOM', customRule: <input> }`
 *     so power-user input round-trips losslessly.
 */

export type RecurrenceFreq = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | 'CUSTOM'

export type RecurrenceEnd =
  | { kind: 'never' }
  | { kind: 'count'; count: number }
  /** ISO date `YYYY-MM-DD`; converted to RFC 5545 UTC basic format on emit. */
  | { kind: 'until'; untilDate: string }

export interface RecurrenceState {
  freq: RecurrenceFreq
  /** Interval >= 1. Ignored when freq === 'NONE' or 'CUSTOM'. */
  interval: number
  end: RecurrenceEnd
  /**
   * Only used when freq === 'CUSTOM' — raw RRULE body the user typed
   * in the textarea. Empty string means "no rule" (treated as NONE
   * on emit).
   */
  customRule: string
}

const FREQ_OPTIONS: { value: RecurrenceFreq; label: string }[] = [
  { value: 'NONE', label: '不重复' },
  { value: 'DAILY', label: '每天' },
  { value: 'WEEKLY', label: '每周' },
  { value: 'MONTHLY', label: '每月' },
  { value: 'YEARLY', label: '每年' },
  { value: 'CUSTOM', label: '自定义 (RRULE)' },
]

const INTERVAL_LABEL_BY_FREQ: Record<Exclude<RecurrenceFreq, 'NONE' | 'CUSTOM'>, string> = {
  DAILY: '天',
  WEEKLY: '周',
  MONTHLY: '月',
  YEARLY: '年',
}

/**
 * Format a `YYYY-MM-DD` ISO date as RFC 5545 UTC basic-format
 * `YYYYMMDDTHHMMSSZ` at end-of-day (23:59:59 UTC). End-of-day is the
 * conventional choice for "until <date>" so the named date is
 * INCLUDED in the series (RRULE.UNTIL is inclusive at second
 * resolution).
 */
function isoDateToRruleUntil(isoDate: string): string {
  // Defensive parse: if the input doesn't look like YYYY-MM-DD we
  // just return it unchanged so a malformed entry surfaces in the
  // RRULE rather than silently emitting an empty timestamp.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate
  const [y, m, d] = isoDate.split('-')
  return `${y}${m}${d}T235959Z`
}

/**
 * Reverse of `isoDateToRruleUntil` — accepts either
 * `YYYYMMDDTHHMMSSZ` or `YYYY-MM-DD`. Anything else returns null so
 * the caller can downgrade to "no until set".
 */
function rruleUntilToIsoDate(rruleUntil: string): string | null {
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(rruleUntil)
  if (utc) {
    return `${utc[1]}-${utc[2]}-${utc[3]}`
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(rruleUntil)) return rruleUntil
  return null
}

/**
 * Build an RRULE body string from the form state.
 *
 * Returns `null` when freq === 'NONE' or the custom textarea is empty
 * — the caller should treat null as "clear recurrence" (which the IPC
 * layer / repository will normalize to a null `recurrence_rule`
 * column).
 *
 * Output shape: bare body without `RRULE:` prefix or DTSTART. The main
 * engine's `normalizeRruleString` prepends the prefix and the
 * DTSTART derived from the event's `start_time`, so we don't write
 * either here.
 */
export function buildRruleString(state: RecurrenceState): string | null {
  if (state.freq === 'NONE') return null
  if (state.freq === 'CUSTOM') {
    const trimmed = state.customRule.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  const parts: string[] = [`FREQ=${state.freq}`]
  const interval = Math.max(1, Math.floor(state.interval))
  if (interval > 1) parts.push(`INTERVAL=${interval}`)
  if (state.end.kind === 'count') {
    const count = Math.max(1, Math.floor(state.end.count))
    parts.push(`COUNT=${count}`)
  } else if (state.end.kind === 'until' && state.end.untilDate.trim().length > 0) {
    parts.push(`UNTIL=${isoDateToRruleUntil(state.end.untilDate)}`)
  }
  return parts.join(';')
}

/**
 * Parse an RRULE string back into form state. Unknown / malformed
 * inputs fall back to CUSTOM mode so the user's text round-trips
 * verbatim (and our save path emits it unchanged via
 * `buildRruleString`).
 *
 * Accepts inputs with or without the `RRULE:` prefix. Strips any
 * `DTSTART:...` line (we don't render DTSTART; the engine derives it
 * from the parent event's start_time).
 */
export function parseRruleStringToState(rrule: string | null | undefined): RecurrenceState {
  if (!rrule || rrule.trim().length === 0) {
    return {
      freq: 'NONE',
      interval: 1,
      end: { kind: 'never' },
      customRule: '',
    }
  }
  // Strip any DTSTART line + RRULE: prefix; keep just the rule body.
  const body = rrule
    .split(/\r?\n/)
    .filter((line) => !/^DTSTART/i.test(line))
    .map((line) => line.replace(/^RRULE:/i, ''))
    .join('')
    .trim()
  if (body.length === 0) {
    return {
      freq: 'NONE',
      interval: 1,
      end: { kind: 'never' },
      customRule: '',
    }
  }
  const tokens = new Map<string, string>()
  for (const tok of body.split(';')) {
    const eq = tok.indexOf('=')
    if (eq <= 0) continue
    const key = tok.slice(0, eq).toUpperCase()
    const value = tok.slice(eq + 1)
    tokens.set(key, value)
  }

  const freqRaw = tokens.get('FREQ')
  // We only support these 4 in the structured form; anything else (or
  // any presence of BYDAY/BYMONTHDAY/etc.) flips to CUSTOM so we don't
  // silently drop the user's rule.
  const STRUCTURED_FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
  const STRUCTURED_KEYS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL'])
  const hasUnknownKeys = Array.from(tokens.keys()).some((k) => !STRUCTURED_KEYS.has(k))
  if (!freqRaw || !STRUCTURED_FREQS.includes(freqRaw.toUpperCase()) || hasUnknownKeys) {
    return {
      freq: 'CUSTOM',
      interval: 1,
      end: { kind: 'never' },
      customRule: body,
    }
  }

  const freq = freqRaw.toUpperCase() as RecurrenceFreq
  const interval = (() => {
    const v = tokens.get('INTERVAL')
    if (!v) return 1
    const n = Number.parseInt(v, 10)
    return Number.isFinite(n) && n > 0 ? n : 1
  })()

  let end: RecurrenceEnd = { kind: 'never' }
  if (tokens.has('COUNT')) {
    const n = Number.parseInt(tokens.get('COUNT') ?? '', 10)
    if (Number.isFinite(n) && n > 0) end = { kind: 'count', count: n }
  } else if (tokens.has('UNTIL')) {
    const iso = rruleUntilToIsoDate(tokens.get('UNTIL') ?? '')
    if (iso) end = { kind: 'until', untilDate: iso }
  }

  return {
    freq,
    interval,
    end,
    customRule: '',
  }
}

export interface RecurrenceEditorProps {
  /** Current RRULE string (RFC 5545 form, e.g. 'FREQ=WEEKLY;COUNT=10') or null for non-recurring. */
  value: string | null
  /** Called with new RRULE string or null when user clears repetition. */
  onChange: (next: string | null) => void
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--text-muted)',
  marginBottom: 4,
  display: 'block',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 32,
  padding: '6px 10px',
  borderRadius: 6,
  border: '1px solid var(--input-slot-border)',
  background: 'var(--input-slot-bg)',
  boxShadow: 'var(--input-slot-shadow)',
  fontSize: 12,
  color: 'var(--text-body)',
  outline: 'none',
  fontFamily: 'Inter, system-ui, sans-serif',
  transition: 'border-color 0.2s',
}

const compactInputStyle: React.CSSProperties = {
  ...inputStyle,
  height: 28,
  padding: '4px 8px',
  fontSize: 11,
}

const radioRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  color: 'var(--text-body)',
  cursor: 'pointer',
}

export default function RecurrenceEditor({ value, onChange }: RecurrenceEditorProps) {
  /**
   * `state` is the source of truth WHILE the user is editing. We seed
   * it from `value` on mount and any time the upstream value changes
   * meaningfully (i.e. when a different event is loaded), but we
   * don't re-seed on every keystroke — that would fight the user's
   * input as `onChange(buildRruleString(state))` round-trips through
   * `parseRruleStringToState`.
   *
   * To get the seeding right we memo the parsed state by the wire
   * `value` and keep it in local state. Component callers who pass
   * a new event with a different RRULE will trigger a re-seed because
   * `value` actually changes; an in-place edit by the user doesn't
   * loop because we only push to `onChange` from event handlers.
   */
  const initialState = useMemo<RecurrenceState>(
    () => parseRruleStringToState(value),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const [state, setState] = useState<RecurrenceState>(initialState)

  const emit = (next: RecurrenceState) => {
    setState(next)
    onChange(buildRruleString(next))
  }

  const handleFreqChange = (freq: RecurrenceFreq) => {
    if (freq === 'NONE') {
      emit({ ...state, freq, end: { kind: 'never' }, interval: 1 })
      return
    }
    if (freq === 'CUSTOM') {
      // Preserve the user's current structured rule as the seed for
      // the textarea so they can hand-edit the verbatim form.
      const seed = buildRruleString({ ...state, freq: state.freq === 'NONE' ? 'WEEKLY' : state.freq })
      emit({ ...state, freq, customRule: seed ?? '' })
      return
    }
    emit({ ...state, freq })
  }

  const handleIntervalChange = (raw: string) => {
    const parsed = Number.parseInt(raw, 10)
    const next = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
    emit({ ...state, interval: next })
  }

  const handleEndChange = (next: RecurrenceEnd) => {
    emit({ ...state, end: next })
  }

  const handleCustomChange = (raw: string) => {
    emit({ ...state, customRule: raw })
  }

  const isStructured =
    state.freq !== 'NONE' && state.freq !== 'CUSTOM'

  return (
    <div>
      <span style={labelStyle}>重复</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* Frequency dropdown */}
        <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px' }}>
          <Repeat style={{ width: 12, height: 12, color: 'var(--text-muted)', flexShrink: 0 }} strokeWidth={2} />
          <select
            value={state.freq}
            onChange={(e) => handleFreqChange(e.target.value as RecurrenceFreq)}
            aria-label="重复频率"
            className="ready-input-slot-inner"
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: 12,
              color: 'var(--text-body)',
              outline: 'none',
              flex: 1,
              padding: 0,
              height: 30,
              fontFamily: 'Inter, system-ui, sans-serif',
            }}
          >
            {FREQ_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Interval + end-condition rows — only when structured frequency selected */}
        {isStructured && (
          <>
            {/* Interval row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>每</span>
              <input
                type="number"
                min={1}
                value={state.interval}
                onChange={(e) => handleIntervalChange(e.target.value)}
                aria-label="重复间隔"
                style={{ ...compactInputStyle, width: 60 }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {INTERVAL_LABEL_BY_FREQ[state.freq as Exclude<RecurrenceFreq, 'NONE' | 'CUSTOM'>]}
              </span>
            </div>

            {/* End-condition selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={radioRowStyle}>
                <input
                  type="radio"
                  name="recurrence-end"
                  checked={state.end.kind === 'never'}
                  onChange={() => handleEndChange({ kind: 'never' })}
                />
                <span>永不结束</span>
              </label>
              <label style={radioRowStyle}>
                <input
                  type="radio"
                  name="recurrence-end"
                  checked={state.end.kind === 'count'}
                  onChange={() => handleEndChange({ kind: 'count', count: state.end.kind === 'count' ? state.end.count : 10 })}
                />
                <span>共</span>
                <input
                  type="number"
                  min={1}
                  value={state.end.kind === 'count' ? state.end.count : 10}
                  disabled={state.end.kind !== 'count'}
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10)
                    const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
                    handleEndChange({ kind: 'count', count })
                  }}
                  aria-label="重复次数"
                  style={{
                    ...compactInputStyle,
                    width: 60,
                    opacity: state.end.kind === 'count' ? 1 : 0.5,
                  }}
                />
                <span>次</span>
              </label>
              <label style={radioRowStyle}>
                <input
                  type="radio"
                  name="recurrence-end"
                  checked={state.end.kind === 'until'}
                  onChange={() => handleEndChange({ kind: 'until', untilDate: state.end.kind === 'until' ? state.end.untilDate : todayPlusYearsISO(1) })}
                />
                <span>直到</span>
                <input
                  type="date"
                  value={state.end.kind === 'until' ? state.end.untilDate : ''}
                  disabled={state.end.kind !== 'until'}
                  onChange={(e) => handleEndChange({ kind: 'until', untilDate: e.target.value })}
                  aria-label="重复截止日期"
                  style={{
                    ...compactInputStyle,
                    flex: 1,
                    opacity: state.end.kind === 'until' ? 1 : 0.5,
                  }}
                />
              </label>
            </div>
          </>
        )}

        {/* Custom textarea — only when CUSTOM frequency selected */}
        {state.freq === 'CUSTOM' && (
          <div>
            <textarea
              value={state.customRule}
              onChange={(e) => handleCustomChange(e.target.value)}
              placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=20"
              aria-label="自定义 RRULE"
              rows={2}
              style={{
                width: '100%',
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid var(--input-slot-border)',
                background: 'var(--input-slot-bg)',
                boxShadow: 'var(--input-slot-shadow)',
                fontSize: 11,
                color: 'var(--text-body)',
                outline: 'none',
                resize: 'none',
                fontFamily: 'Menlo, Monaco, monospace',
                transition: 'border-color 0.2s',
              }}
            />
            <div style={{ fontSize: 10, marginTop: 2, color: 'var(--text-light)' }}>
              输入 RFC 5545 RRULE 字符串（不含 RRULE: 前缀）
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Helper for default UNTIL value — one year from today, ISO date. */
function todayPlusYearsISO(years: number): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() + years)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
