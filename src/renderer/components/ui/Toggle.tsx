import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Minus } from 'lucide-react'

// Switch, Checkbox, Segmented (W1 §5). "On" is ink, not the signal colour (DL5).
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="rn-switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean | 'mixed'; onChange: (checked: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="rn-check">
      <button type="button" role="checkbox" className="rn-check__box" aria-checked={checked} disabled={disabled} onClick={() => onChange(checked !== true)}>
        {checked === 'mixed' ? <Minus aria-hidden="true" /> : <Check aria-hidden="true" />}
      </button>
      <span>{label}</span>
    </label>
  )
}

/** A radio group drawn as a pill track; ←/→ move the choice. */
export function Segmented<T extends string>({ options, value, onChange, label, className }: {
  /** With an `icon` the item shows only the icon; its label names it for a pointer and a screen reader. */
  options: { value: T; label: string; count?: ReactNode; icon?: ReactNode }[]; value: T; onChange: (value: T) => void; label: string; className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const index = (options.findIndex(option => option.value === value) + step + options.length) % options.length
    onChange(options[index].value)
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus()
  }
  return (
    <div ref={ref} className={className ? `rn-seg ${className}` : 'rn-seg'} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map(option => (
        <button key={option.value} type="button" role="radio" className="rn-seg__item" aria-checked={option.value === value} tabIndex={option.value === value ? 0 : -1} onClick={() => onChange(option.value)}
          {...(option.icon ? { 'aria-label': option.label, title: option.label, 'data-icon': '' } : {})}>
          {option.icon ?? option.label}
          {option.count !== undefined && <span className="rn-seg__count">{option.count}</span>}
        </button>
      ))}
    </div>
  )
}
