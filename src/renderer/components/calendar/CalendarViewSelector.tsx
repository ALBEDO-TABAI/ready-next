import { useEffect, useRef, useState } from 'react'

import type { ViewType } from './schedule-x-utils'

const VIEW_OPTIONS: { value: ViewType; label: string }[] = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
]

export default function CalendarViewSelector({
  viewType,
  onViewTypeChange,
}: {
  viewType: ViewType
  onViewTypeChange: (value: ViewType) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const currentLabel = VIEW_OPTIONS.find((option) => option.value === viewType)?.label || '周'

  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 10px', borderRadius: 10,
          border: '1px solid var(--border-input)', background: 'transparent',
          fontSize: 12, fontWeight: 500, color: 'var(--text-body)',
          cursor: 'pointer',
        }}
      >
        {currentLabel}
      </button>
      {open && (
        <div
          className="glass-surface-floating"
          style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4,
            background: 'var(--surface-floating-bg)', border: '1px solid var(--border-default)',
            borderRadius: 8, padding: 4, zIndex: 50,
            boxShadow: 'var(--surface-shadow)',
            minWidth: 60,
          }}
        >
          {VIEW_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => {
                onViewTypeChange(value)
                setOpen(false)
              }}
              style={{
                display: 'block', width: '100%',
                padding: '4px 10px', borderRadius: 6,
                border: 'none', cursor: 'pointer', textAlign: 'left',
                fontSize: 12, fontWeight: viewType === value ? 600 : 400,
                color: viewType === value ? 'var(--color-blue)' : 'var(--text-body)',
                background: viewType === value ? 'var(--color-blue-light)' : 'transparent',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
