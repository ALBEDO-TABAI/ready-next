import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import {
  STAT_CARD_DEFAULT_PADDING,
  STAT_CARD_DEFAULT_PROPS,
  type StatCardShape,
} from './types'

export class StatCardShapeUtil extends BaseBoxShapeUtil<StatCardShape> {
  static type = 'ui-stat-card' as const
  static props = {
    w: T.number,
    h: T.number,
    label: T.string,
    value: T.string,
    delta: T.string,
  }

  getDefaultProps(): StatCardShape['props'] {
    return { ...STAT_CARD_DEFAULT_PROPS }
  }

  component(shape: StatCardShape) {
    const { w, h, label, value, delta } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 18
    const paddingH = typeof meta.readyPaddingH === 'number' ? Math.max(0, Number(meta.readyPaddingH)) : STAT_CARD_DEFAULT_PADDING.horizontal
    const paddingV = typeof meta.readyPaddingV === 'number' ? Math.max(0, Number(meta.readyPaddingV)) : STAT_CARD_DEFAULT_PADDING.vertical
    const fillColor = typeof meta.readyFillColor === 'string' ? String(meta.readyFillColor) : 'var(--bg-primary)'
    const fillOpacity = typeof meta.readyFillOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyFillOpacity))) : 100
    const strokeColor = typeof meta.readyStrokeColor === 'string' ? String(meta.readyStrokeColor) : 'var(--border-default)'
    const strokeOpacity = typeof meta.readyStrokeOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyStrokeOpacity))) : 100
    const strokeWidth = typeof meta.readyStrokeWidth === 'number' ? Math.max(0, Number(meta.readyStrokeWidth)) : 1
    const strokePaint = `color-mix(in srgb, ${strokeColor} ${strokeOpacity}%, transparent)`
    const fillMain = `color-mix(in srgb, ${fillColor} ${fillOpacity}%, transparent)`
    const textColor = typeof meta.readyTextColor === 'string' ? String(meta.readyTextColor) : 'var(--text-title)'
    const valueSize = typeof meta.readyFontSize === 'number' ? Math.max(18, Number(meta.readyFontSize)) : 28
    const valueWeight = meta.readyFontWeight === 'bold' ? 700 : meta.readyFontWeight === 'medium' ? 600 : 700
    const deltaPositive = !delta.startsWith('-')

    return (
      <HTMLContainer
        style={{
          width: Math.max(160, w),
          height: Math.max(108, h),
          boxSizing: 'border-box',
          borderRadius: cornerRadius,
          border: `${strokeWidth}px solid ${strokePaint}`,
          background: `linear-gradient(180deg, color-mix(in srgb, ${fillMain} 98%, white) 0%, color-mix(in srgb, ${fillMain} 76%, var(--bg-panel)) 100%)`,
          padding: `${paddingV}px ${paddingH}px`,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <div style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 700 }}>
          {label || 'Metric'}
        </div>
        <div style={{ fontSize: valueSize, lineHeight: 1, fontWeight: valueWeight, color: textColor }}>
          {value || '0'}
        </div>
        <div
          style={{
            alignSelf: 'flex-start',
            minHeight: 24,
            borderRadius: 999,
            padding: '0 10px',
            display: 'inline-flex',
            alignItems: 'center',
            fontSize: 11,
            fontWeight: 700,
            color: deltaPositive ? 'var(--color-green)' : 'var(--color-red)',
            background: deltaPositive
              ? 'color-mix(in srgb, var(--color-green) 10%, white)'
              : 'color-mix(in srgb, var(--color-red) 10%, white)',
          }}
        >
          {delta || '+0%'}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: StatCardShape) {
    const { w, h } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 18
    return <rect width={Math.max(1, w)} height={Math.max(1, h)} rx={cornerRadius} ry={cornerRadius} />
  }
}
