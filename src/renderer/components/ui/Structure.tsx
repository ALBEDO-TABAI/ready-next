import { useRef, useState, type HTMLAttributes, type MouseEvent, type PointerEvent, type ReactNode } from 'react'

// ListRow, Toolbar, ScrollArea, ResizeHandle (W1 §5). A current row is --rn-fill-2 + ink + 500, never the signal
// colour (V5); its icon takes the row's text colour (the rail's white glyph is the rail's alone).
export function ListRow({ icon, label, meta, current, onClick, className = '', ...rest }: { icon?: ReactNode; label: ReactNode; meta?: ReactNode; current?: boolean; onClick?: (event: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean } & Omit<HTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  return (
    <button type="button" className={`rn-row ${className}`.trim()} aria-current={current ? 'page' : undefined} onClick={onClick} {...rest}>
      {icon}
      <span className="rn-row__label">{label}</span>
      {meta !== undefined && <span className="rn-row__meta">{meta}</span>}
    </button>
  )
}

export function Toolbar({ label, children }: { label: string; children: ReactNode }) {
  return <div className="rn-toolbar" role="toolbar" aria-label={label}>{children}</div>
}

export function ToolbarSeparator() {
  return <span className="rn-toolbar__sep" role="separator" aria-orientation="vertical" />
}

export function ScrollArea({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rn-scroll ${className}`.trim()} {...rest} />
}

/** Drag to resize the neighbouring column (or row); arrow keys nudge by 8px. */
export function ResizeHandle({ onResize, orientation = 'vertical', label }: { onResize: (delta: number) => void; orientation?: 'vertical' | 'horizontal'; label: string }) {
  const last = useRef(0)
  const [dragging, setDragging] = useState(false)
  const coord = (event: PointerEvent) => (orientation === 'vertical' ? event.clientX : event.clientY)
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      tabIndex={0}
      className="rn-resize"
      data-orientation={orientation}
      data-dragging={dragging || undefined}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); last.current = coord(event); setDragging(true) }}
      onPointerMove={event => { if (!dragging) return; const now = coord(event); onResize(now - last.current); last.current = now }}
      onPointerUp={() => setDragging(false)}
      onKeyDown={event => {
        const back = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
        const forward = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
        if (event.key === back) { event.preventDefault(); onResize(-8) }
        if (event.key === forward) { event.preventDefault(); onResize(8) }
      }}
    />
  )
}
