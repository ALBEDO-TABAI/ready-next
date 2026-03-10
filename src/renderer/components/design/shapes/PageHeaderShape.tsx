import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import {
  PAGE_HEADER_DEFAULT_PADDING,
  PAGE_HEADER_DEFAULT_PROPS,
  type PageHeaderShape,
} from './types'

export class PageHeaderShapeUtil extends BaseBoxShapeUtil<PageHeaderShape> {
  static type = 'ui-page-header' as const
  static props = {
    w: T.number,
    h: T.number,
    eyebrow: T.string,
    title: T.string,
    meta: T.string,
    actionLabel: T.string,
  }

  getDefaultProps(): PageHeaderShape['props'] {
    return { ...PAGE_HEADER_DEFAULT_PROPS }
  }

  component(shape: PageHeaderShape) {
    const { w, h, eyebrow, title, meta: metaLine, actionLabel } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 22
    const paddingH = typeof meta.readyPaddingH === 'number' ? Math.max(0, Number(meta.readyPaddingH)) : PAGE_HEADER_DEFAULT_PADDING.horizontal
    const paddingV = typeof meta.readyPaddingV === 'number' ? Math.max(0, Number(meta.readyPaddingV)) : PAGE_HEADER_DEFAULT_PADDING.vertical
    const fillColor = typeof meta.readyFillColor === 'string' ? String(meta.readyFillColor) : 'var(--bg-primary)'
    const fillOpacity = typeof meta.readyFillOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyFillOpacity))) : 100
    const strokeColor = typeof meta.readyStrokeColor === 'string' ? String(meta.readyStrokeColor) : 'var(--border-default)'
    const strokeOpacity = typeof meta.readyStrokeOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyStrokeOpacity))) : 100
    const strokeWidth = typeof meta.readyStrokeWidth === 'number' ? Math.max(0, Number(meta.readyStrokeWidth)) : 1
    const strokeVisible = meta.readyStrokeVisible !== false
    const textColor = typeof meta.readyTextColor === 'string' ? String(meta.readyTextColor) : 'var(--text-title)'
    const fontFamily = meta.readyFontFamily === 'serif'
      ? 'ui-serif, Georgia, serif'
      : meta.readyFontFamily === 'mono'
        ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
        : meta.readyFontFamily === 'draw'
          ? "'Comic Sans MS', cursive"
          : 'inherit'
    const titleSize = typeof meta.readyFontSize === 'number' ? Math.max(14, Number(meta.readyFontSize)) : 28
    const titleWeight = meta.readyFontWeight === 'bold' ? 700 : meta.readyFontWeight === 'medium' ? 600 : 600
    const lineHeight = typeof meta.readyLineHeight === 'number' && meta.readyLineHeight > 0 ? `${meta.readyLineHeight}px` : '1.1'
    const letterSpacing = typeof meta.readyLetterSpacing === 'number' ? `${meta.readyLetterSpacing}px` : '-0.02em'
    const textAlign = meta.readyTextAlign === 'middle' ? 'center' : meta.readyTextAlign === 'end' ? 'right' : 'left'
    const fillMain = `color-mix(in srgb, ${fillColor} ${fillOpacity}%, transparent)`
    const strokePaint = `color-mix(in srgb, ${strokeColor} ${strokeOpacity}%, transparent)`
    const border = strokeVisible ? `${strokeWidth}px solid ${strokePaint}` : 'none'

    return (
      <HTMLContainer
        style={{
          width: Math.max(280, w),
          height: Math.max(96, h),
          borderRadius: cornerRadius,
          border,
          background: `linear-gradient(135deg, color-mix(in srgb, ${fillMain} 92%, white) 0%, color-mix(in srgb, ${fillMain} 74%, var(--bg-panel)) 100%)`,
          boxSizing: 'border-box',
          padding: `${paddingV}px ${paddingH}px`,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          gap: 16,
          alignItems: 'center',
        }}
      >
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, textAlign }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            {eyebrow || 'Section'}
          </div>
          <div style={{ fontSize: titleSize, fontWeight: titleWeight, lineHeight, letterSpacing, color: textColor, fontFamily }}>
            {title || 'Page Header'}
          </div>
          <div style={{ fontSize: 12, lineHeight: '1.5', color: 'var(--text-muted)', fontFamily }}>
            {metaLine || 'Context line'}
          </div>
        </div>
        <div
          style={{
            alignSelf: 'flex-start',
            minWidth: 120,
            height: 40,
            borderRadius: 999,
            border: `1px solid ${strokePaint}`,
            background: 'color-mix(in srgb, var(--color-blue) 8%, white)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 18px',
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--color-blue)',
            boxSizing: 'border-box',
            whiteSpace: 'nowrap',
          }}
        >
          {actionLabel || 'Primary Action'}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: PageHeaderShape) {
    const { w, h } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 22
    return <rect width={Math.max(1, w)} height={Math.max(1, h)} rx={cornerRadius} ry={cornerRadius} />
  }
}
