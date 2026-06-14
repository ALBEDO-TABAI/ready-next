import { useEffect, useMemo, useRef, useState } from 'react'
import { Globe } from 'lucide-react'

import {
  buildFloatingMenuItemStyle,
} from '../ui/floatingMenuStyles'
import { chatMenuSurfaceStyle } from '../agent/chatMenuStyles'
import { LiquidFloatingPanel } from '../ui/liquid-glass/LiquidFloatingPanel'

/**
 * L4-A-Timezone — toolbar dropdown for picking the calendar view's
 * display timezone.
 *
 * Behavior contract:
 *   - The current value is read from `useCalendarSession.displayTimezone`
 *     (the caller passes it as `value`). Default is the user's local
 *     IANA zone (e.g. 'Asia/Shanghai' resolved by Intl). The dropdown
 *     shows a curated list of ~10-12 common zones plus a free-text
 *     search input so the user can type any IANA identifier (e.g.
 *     'Europe/Berlin', 'Pacific/Auckland').
 *   - Selecting a zone fires `onChange(tz)` and closes the dropdown.
 *   - Typing into the search input filters the curated list by
 *     substring against both the IANA id and its Chinese label. If
 *     `Intl.supportedValuesOf('timeZone')` is available we extend the
 *     filter to the full IANA set so power users can find any zone.
 *
 * Layered modeling note: per CLAUDE.md §6.0.1.2 ("简单优先") we deliberately
 * do NOT pull in a search-rank library or a virtualized list — the
 * curated set is short and the IANA set is small enough (<400 entries)
 * that a substring filter renders instantly.
 */

interface TimezoneOption {
  id: string
  label: string
}

// Curated common set. Order is the order shown when the search is
// empty; the user's current zone (if not in this set) is prepended so
// it's always visible without typing.
const COMMON_TIMEZONES: TimezoneOption[] = [
  { id: 'Asia/Shanghai', label: '上海 / 北京' },
  { id: 'Asia/Tokyo', label: '东京' },
  { id: 'Asia/Singapore', label: '新加坡' },
  { id: 'Asia/Hong_Kong', label: '香港' },
  { id: 'Asia/Seoul', label: '首尔' },
  { id: 'Asia/Bangkok', label: '曼谷' },
  { id: 'Asia/Dubai', label: '迪拜' },
  { id: 'Europe/London', label: '伦敦' },
  { id: 'Europe/Paris', label: '巴黎' },
  { id: 'Europe/Berlin', label: '柏林' },
  { id: 'Europe/Moscow', label: '莫斯科' },
  { id: 'America/New_York', label: '纽约' },
  { id: 'America/Chicago', label: '芝加哥' },
  { id: 'America/Denver', label: '丹佛' },
  { id: 'America/Los_Angeles', label: '洛杉矶' },
  { id: 'America/Sao_Paulo', label: '圣保罗' },
  { id: 'Australia/Sydney', label: '悉尼' },
  { id: 'Pacific/Auckland', label: '奥克兰' },
  { id: 'UTC', label: 'UTC' },
]

function getTimezoneLabel(id: string): string {
  return COMMON_TIMEZONES.find((option) => option.id === id)?.label || id
}

/**
 * Best-effort wrapper around `Intl.supportedValuesOf('timeZone')` so a
 * runtime that doesn't ship it (older Node test environments,
 * non-ICU-full builds) doesn't crash. Returns an empty array on
 * failure — the curated list still works.
 */
function getAllIanaTimezones(): string[] {
  try {
    // `Intl.supportedValuesOf` is Stage-4 ECMA but not in all TS lib
    // configs — narrow access through `as unknown` so the typecheck
    // stays clean.
    const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    if (typeof fn !== 'function') return []
    return fn('timeZone')
  } catch {
    // silent-catch: older Intl builds may not support timeZone enumeration; curated zones still work.
    return []
  }
}

interface CalendarTimezoneSelectorProps {
  value: string
  onChange: (tz: string) => void
}

export default function CalendarTimezoneSelector({
  value,
  onChange,
}: CalendarTimezoneSelectorProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Build the displayed list. Empty query → curated set (with the
  // user's current zone prepended if not already in it). Non-empty
  // query → curated + IANA full set, filtered by substring on id /
  // label / lowercased id.
  const options = useMemo<TimezoneOption[]>(() => {
    const trimmed = query.trim().toLowerCase()
    const seen = new Set<string>()
    const out: TimezoneOption[] = []

    // Pin current zone first when no search active so the user can see
    // their selection without typing — even when it's a non-curated
    // zone like 'Atlantic/Reykjavik'.
    if (!trimmed && !COMMON_TIMEZONES.some((o) => o.id === value)) {
      out.push({ id: value, label: value })
      seen.add(value)
    }

    for (const opt of COMMON_TIMEZONES) {
      if (seen.has(opt.id)) continue
      if (!trimmed) {
        out.push(opt)
        seen.add(opt.id)
        continue
      }
      if (opt.id.toLowerCase().includes(trimmed) || opt.label.toLowerCase().includes(trimmed)) {
        out.push(opt)
        seen.add(opt.id)
      }
    }

    // On non-empty query, also offer matches from the full IANA list.
    if (trimmed) {
      for (const tz of getAllIanaTimezones()) {
        if (seen.has(tz)) continue
        if (tz.toLowerCase().includes(trimmed)) {
          out.push({ id: tz, label: tz })
          seen.add(tz)
        }
      }
    }

    return out
  }, [query, value])

  // Display label for the current value — keep the compact city label
  // in chrome; raw IANA ids stay available through search results.
  const currentLabel = useMemo(() => {
    return getTimezoneLabel(value)
  }, [value])

  return (
    <div ref={ref} className="calendar-timezone-selector" style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        aria-label="切换时区显示"
        title={`当前显示时区：${currentLabel}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 10px', borderRadius: 10,
          border: '1px solid var(--border-input)', background: 'transparent',
          fontSize: 12, fontWeight: 500, color: 'var(--text-body)',
          cursor: 'pointer',
          maxWidth: 240,
        }}
      >
        <Globe style={{ width: 13, height: 13, color: 'var(--text-muted)', flexShrink: 0 }} />
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {currentLabel}
        </span>
      </button>
      {open && (
        <LiquidFloatingPanel
          className="calendar-timezone-menu"
          radius={16}
          style={{
            ...chatMenuSurfaceStyle,
            width: 280,
            maxHeight: 360,
            minWidth: 240,
            padding: 6,
            zIndex: 80,
            position: 'absolute',
            bottom: '100%',
            right: 0,
            marginBottom: 4,
          }}
          contentStyle={{
            maxHeight: 348,
            overflowY: 'auto',
          }}
        >
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索时区（IANA 标识或城市名）"
            autoFocus
            style={{
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid var(--border-input)',
              background: 'transparent',
              fontSize: 12,
              color: 'var(--text-body)',
              marginBottom: 4,
              width: '100%',
              boxSizing: 'border-box',
            }}
          />
          {options.length === 0 && (
            <div
              style={{
                padding: '8px 10px',
                fontSize: 12,
                color: 'var(--text-muted)',
              }}
            >
              无匹配时区
            </div>
          )}
          {options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => {
                onChange(opt.id)
                setQuery('')
                setOpen(false)
              }}
              className={`ready-floating-menu-item ${value === opt.id ? 'is-selected' : ''}`}
              style={{
                ...buildFloatingMenuItemStyle({ compact: true, selected: value === opt.id }),
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                fontWeight: value === opt.id ? 600 : 500,
                color: 'var(--text-body)',
                textAlign: 'left',
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {opt.label}
              </span>
            </button>
          ))}
        </LiquidFloatingPanel>
      )}
    </div>
  )
}
