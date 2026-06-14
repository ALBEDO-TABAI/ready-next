import type { CSSProperties } from 'react'
import { dotGlyphCells, type DotGlyphName, type DotGlyphTone } from './dot-glyphs'

export interface DotGlyphProps {
  name: DotGlyphName
  /** Cell-grid size driver in px; scales the whole icon without distorting dot spacing. */
  size?: number
  /** `signal` tints with the alert red (reserved for genuine signals); `neutral` = currentColor. */
  tone?: DotGlyphTone
  /** Animate lit cells (used by the running state). Respects prefers-reduced-motion. */
  pulse?: boolean
  className?: string
  style?: CSSProperties
  /** Accessible label for the glyph. */
  title?: string
}

/**
 * Renders a 9×9 dot-matrix glyph as a CSS grid of complete circles. Lit cells
 * inherit `currentColor` (neutral) or turn alert-red (signal) via CSS keyed on
 * the `data-dot-glyph-tone` attribute.
 */
export function DotGlyph({
  name,
  size = 14,
  tone = 'neutral',
  pulse = false,
  className,
  style,
  title,
}: DotGlyphProps) {
  const cells = dotGlyphCells(name)
  const classes = ['dot-glyph']
  if (pulse) classes.push('dot-glyph--pulse')
  if (className) classes.push(className)

  return (
    <span
      role="img"
      aria-label={title ?? name}
      data-dot-glyph={name}
      data-dot-glyph-tone={tone}
      className={classes.join(' ')}
      style={{ '--dot-glyph-size': `${size}px`, ...style } as CSSProperties}
    >
      {cells.map((lit, i) => (
        <i key={i} aria-hidden="true" className={lit ? 'on' : undefined} />
      ))}
    </span>
  )
}
