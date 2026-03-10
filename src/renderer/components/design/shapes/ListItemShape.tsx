import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import {
  LIST_ITEM_DEFAULT_PADDING,
  LIST_ITEM_DEFAULT_PROPS,
  type ListItemShape,
} from './types'

export class ListItemShapeUtil extends BaseBoxShapeUtil<ListItemShape> {
  static type = 'ui-list-item' as const
  static props = {
    w: T.number,
    h: T.number,
    title: T.string,
    meta: T.string,
    description: T.string,
  }

  getDefaultProps(): ListItemShape['props'] {
    return { ...LIST_ITEM_DEFAULT_PROPS }
  }

  component(shape: ListItemShape) {
    const { w, h, title, meta: metaLine, description } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 16
    const paddingH = typeof meta.readyPaddingH === 'number' ? Math.max(0, Number(meta.readyPaddingH)) : LIST_ITEM_DEFAULT_PADDING.horizontal
    const paddingV = typeof meta.readyPaddingV === 'number' ? Math.max(0, Number(meta.readyPaddingV)) : LIST_ITEM_DEFAULT_PADDING.vertical
    const fillColor = typeof meta.readyFillColor === 'string' ? String(meta.readyFillColor) : 'var(--bg-primary)'
    const fillOpacity = typeof meta.readyFillOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyFillOpacity))) : 100
    const strokeColor = typeof meta.readyStrokeColor === 'string' ? String(meta.readyStrokeColor) : 'var(--border-default)'
    const strokeOpacity = typeof meta.readyStrokeOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyStrokeOpacity))) : 100
    const strokeWidth = typeof meta.readyStrokeWidth === 'number' ? Math.max(0, Number(meta.readyStrokeWidth)) : 1
    const strokePaint = `color-mix(in srgb, ${strokeColor} ${strokeOpacity}%, transparent)`
    const fillMain = `color-mix(in srgb, ${fillColor} ${fillOpacity}%, transparent)`
    const textColor = typeof meta.readyTextColor === 'string' ? String(meta.readyTextColor) : 'var(--text-title)'
    const titleSize = typeof meta.readyFontSize === 'number' ? Math.max(12, Number(meta.readyFontSize)) : 15
    const titleWeight = meta.readyFontWeight === 'bold' ? 700 : meta.readyFontWeight === 'medium' ? 600 : 600

    return (
      <HTMLContainer
        style={{
          width: Math.max(240, w),
          height: Math.max(72, h),
          boxSizing: 'border-box',
          borderRadius: cornerRadius,
          border: `${strokeWidth}px solid ${strokePaint}`,
          background: `linear-gradient(180deg, color-mix(in srgb, ${fillMain} 98%, white) 0%, color-mix(in srgb, ${fillMain} 82%, var(--bg-panel)) 100%)`,
          padding: `${paddingV}px ${paddingH}px`,
          display: 'grid',
          gridTemplateColumns: '40px minmax(0, 1fr)',
          gap: 12,
          alignItems: 'start',
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 999,
            background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-blue) 22%, white) 0%, color-mix(in srgb, var(--color-blue) 48%, white) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 800,
            color: 'var(--color-blue)',
          }}
        >
          {(title || 'L').slice(0, 1).toUpperCase()}
        </div>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
            <div style={{ minWidth: 0, fontSize: titleSize, fontWeight: titleWeight, color: textColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title || 'List Item'}
            </div>
            <div style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-muted)' }}>{metaLine || 'Meta'}</div>
          </div>
          <div style={{ fontSize: 12, lineHeight: '1.45', color: 'var(--text-muted)', overflow: 'hidden' }}>
            {description || 'Description'}
          </div>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: ListItemShape) {
    const { w, h } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 16
    return <rect width={Math.max(1, w)} height={Math.max(1, h)} rx={cornerRadius} ry={cornerRadius} />
  }
}
