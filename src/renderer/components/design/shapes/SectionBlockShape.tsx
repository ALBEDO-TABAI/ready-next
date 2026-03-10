import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import {
  SECTION_BLOCK_DEFAULT_PADDING,
  SECTION_BLOCK_DEFAULT_PROPS,
  type SectionBlockShape,
} from './types'

export class SectionBlockShapeUtil extends BaseBoxShapeUtil<SectionBlockShape> {
  static type = 'ui-section-block' as const
  static props = {
    w: T.number,
    h: T.number,
    title: T.string,
    description: T.string,
    columns: T.number,
  }

  getDefaultProps(): SectionBlockShape['props'] {
    return { ...SECTION_BLOCK_DEFAULT_PROPS }
  }

  component(shape: SectionBlockShape) {
    const { w, h, title, description, columns } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const columnCount = Math.max(1, Math.min(3, Math.round(columns || 1)))
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 20
    const paddingH = typeof meta.readyPaddingH === 'number' ? Math.max(0, Number(meta.readyPaddingH)) : SECTION_BLOCK_DEFAULT_PADDING.horizontal
    const paddingV = typeof meta.readyPaddingV === 'number' ? Math.max(0, Number(meta.readyPaddingV)) : SECTION_BLOCK_DEFAULT_PADDING.vertical
    const fillColor = typeof meta.readyFillColor === 'string' ? String(meta.readyFillColor) : 'var(--bg-primary)'
    const fillOpacity = typeof meta.readyFillOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyFillOpacity))) : 100
    const strokeColor = typeof meta.readyStrokeColor === 'string' ? String(meta.readyStrokeColor) : 'var(--border-default)'
    const strokeOpacity = typeof meta.readyStrokeOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyStrokeOpacity))) : 100
    const strokeWidth = typeof meta.readyStrokeWidth === 'number' ? Math.max(0, Number(meta.readyStrokeWidth)) : 1
    const strokePaint = `color-mix(in srgb, ${strokeColor} ${strokeOpacity}%, transparent)`
    const fillMain = `color-mix(in srgb, ${fillColor} ${fillOpacity}%, transparent)`
    const textColor = typeof meta.readyTextColor === 'string' ? String(meta.readyTextColor) : 'var(--text-title)'
    const titleSize = typeof meta.readyFontSize === 'number' ? Math.max(14, Number(meta.readyFontSize)) : 18
    const titleWeight = meta.readyFontWeight === 'bold' ? 700 : meta.readyFontWeight === 'medium' ? 600 : 600
    const textAlign = meta.readyTextAlign === 'middle' ? 'center' : meta.readyTextAlign === 'end' ? 'right' : 'left'

    return (
      <HTMLContainer
        style={{
          width: Math.max(260, w),
          height: Math.max(160, h),
          boxSizing: 'border-box',
          borderRadius: cornerRadius,
          border: `${strokeWidth}px solid ${strokePaint}`,
          background: `linear-gradient(180deg, color-mix(in srgb, ${fillMain} 96%, white) 0%, color-mix(in srgb, ${fillMain} 70%, var(--bg-panel)) 100%)`,
          padding: `${paddingV}px ${paddingH}px`,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, textAlign }}>
          <div style={{ fontSize: titleSize, fontWeight: titleWeight, color: textColor }}>{title || 'Section'}</div>
          <div style={{ fontSize: 12, lineHeight: '1.5', color: 'var(--text-muted)' }}>{description || 'Description'}</div>
        </div>
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`, gap: 12 }}>
          {Array.from({ length: columnCount }).map((_, index) => (
            <div
              key={index}
              style={{
                borderRadius: Math.max(10, cornerRadius - 8),
                border: `1px dashed ${strokePaint}`,
                background: 'color-mix(in srgb, var(--bg-panel) 78%, white)',
                display: 'grid',
                alignContent: 'start',
                gap: 8,
                padding: 12,
                boxSizing: 'border-box',
              }}
            >
              <div style={{ width: '42%', height: 10, borderRadius: 999, background: 'color-mix(in srgb, var(--color-blue) 18%, white)' }} />
              <div style={{ width: '88%', height: 10, borderRadius: 999, background: 'color-mix(in srgb, var(--border-default) 82%, white)' }} />
              <div style={{ width: '72%', height: 10, borderRadius: 999, background: 'color-mix(in srgb, var(--border-default) 64%, white)' }} />
              <div style={{ marginTop: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>Column {index + 1}</div>
            </div>
          ))}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: SectionBlockShape) {
    const { w, h } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 20
    return <rect width={Math.max(1, w)} height={Math.max(1, h)} rx={cornerRadius} ry={cornerRadius} />
  }
}
