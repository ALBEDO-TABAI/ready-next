import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import { CARD_DEFAULT_PROPS, type CardShape } from './types'

export class CardShapeUtil extends BaseBoxShapeUtil<CardShape> {
  static type = 'ui-card' as const
  static props = {
    w: T.number,
    h: T.number,
    title: T.string,
    padding: T.number,
    hasShadow: T.boolean,
  }

  getDefaultProps(): CardShape['props'] {
    return { ...CARD_DEFAULT_PROPS }
  }

  component(shape: CardShape) {
    const { w, h, title, padding, hasShadow } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const fillStyle = typeof meta.readyFillStyle === 'string' ? meta.readyFillStyle : 'solid'
    const fillVisible = meta.readyFillVisible !== false && fillStyle !== 'none'
    const fillOpacity = typeof meta.readyFillOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyFillOpacity))) : 100
    const fillColor = typeof meta.readyFillColor === 'string' ? String(meta.readyFillColor) : 'var(--bg-primary)'
    const strokeColor = typeof meta.readyStrokeColor === 'string' ? String(meta.readyStrokeColor) : 'var(--border-default)'
    const strokeOpacity = typeof meta.readyStrokeOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyStrokeOpacity))) : 100
    const strokeWidth = typeof meta.readyStrokeWidth === 'number' ? Math.max(0, Number(meta.readyStrokeWidth)) : 1
    const strokeVisible = meta.readyStrokeVisible !== false
    const strokeDash = meta.readyStrokeDash === 'dashed'
      ? 'dashed'
      : meta.readyStrokeDash === 'dotted'
        ? 'dotted'
        : 'solid'
    const strokePosition = meta.readyStrokePosition === 'outside'
      ? 'outside'
      : meta.readyStrokePosition === 'inside'
        ? 'inside'
        : 'center'
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 14
    const paddingH = typeof meta.readyPaddingH === 'number' ? Math.max(0, Number(meta.readyPaddingH)) : Math.max(4, padding)
    const paddingV = typeof meta.readyPaddingV === 'number' ? Math.max(0, Number(meta.readyPaddingV)) : Math.max(4, padding)
    const clipContent = meta.readyClipContent === true

    const shadowEnabled = meta.readyDropShadowEnabled === true || hasShadow
    const shadowColor = typeof meta.readyDropShadowColor === 'string' ? String(meta.readyDropShadowColor) : '#000000'
    const shadowOpacity = typeof meta.readyDropShadowOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyDropShadowOpacity))) : 8
    const shadowBlur = typeof meta.readyDropShadowBlur === 'number' ? Math.max(0, Number(meta.readyDropShadowBlur)) : 16
    const shadowX = typeof meta.readyDropShadowX === 'number' ? Number(meta.readyDropShadowX) : 0
    const shadowY = typeof meta.readyDropShadowY === 'number' ? Number(meta.readyDropShadowY) : 8
    const shadowHex = shadowColor.startsWith('#') ? shadowColor.slice(0, 7) : '#000000'
    const shadowAlpha = Math.round((shadowOpacity / 100) * 255).toString(16).padStart(2, '0')
    const shadow = shadowEnabled && shadowBlur > 0
      ? `${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowHex}${shadowAlpha}`
      : 'none'

    const strokePaint = `color-mix(in srgb, ${strokeColor} ${strokeOpacity}%, transparent)`
    const border = !strokeVisible || strokePosition === 'outside' ? 'none' : `${strokeWidth}px ${strokeDash} ${strokePaint}`
    const outsideStroke = strokeVisible && strokePosition === 'outside' && strokeWidth > 0 ? `0 0 0 ${strokeWidth}px ${strokePaint}` : ''
    const boxShadow = [outsideStroke, shadow].filter(Boolean).join(', ') || 'none'
    const fillMain = `color-mix(in srgb, ${fillColor} ${fillOpacity}%, transparent)`
    const fillSoft = `color-mix(in srgb, ${fillColor} ${Math.max(0, Math.round(fillOpacity * 0.62))}%, white)`
    const computedFill = fillVisible
      ? fillStyle === 'semi'
        ? fillSoft
        : fillStyle === 'pattern'
          ? `repeating-linear-gradient(135deg, ${fillMain}, ${fillMain} 8px, ${fillSoft} 8px, ${fillSoft} 16px)`
          : fillStyle === 'lined-fill'
            ? `repeating-linear-gradient(90deg, ${fillSoft}, ${fillSoft} 3px, ${fillMain} 3px, ${fillMain} 6px)`
            : fillMain
      : 'transparent'
    const titleAlign = meta.readyTextAlign === 'middle' ? 'center' : meta.readyTextAlign === 'end' ? 'right' : 'left'
    const titleFontSize = typeof meta.readyFontSize === 'number' ? Math.max(10, Number(meta.readyFontSize)) : 14
    const titleWeight = meta.readyFontWeight === 'bold' ? 700 : meta.readyFontWeight === 'medium' ? 600 : 500
    const titleColor = typeof meta.readyTextColor === 'string' ? String(meta.readyTextColor) : 'var(--text-title)'
    const titleFont = meta.readyFontFamily === 'serif'
      ? 'ui-serif, Georgia, serif'
      : meta.readyFontFamily === 'mono'
        ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
        : meta.readyFontFamily === 'draw'
          ? "'Comic Sans MS', cursive"
          : 'inherit'
    const titleLineHeight = typeof meta.readyLineHeight === 'number' && meta.readyLineHeight > 0
      ? `${meta.readyLineHeight}px`
      : '1.2'
    const titleLetterSpacing = typeof meta.readyLetterSpacing === 'number' ? `${meta.readyLetterSpacing}px` : undefined

    return (
      <HTMLContainer
        style={{
          width: Math.max(80, w),
          height: Math.max(60, h),
          borderRadius: cornerRadius,
          border,
          background: computedFill,
          boxSizing: 'border-box',
          padding: `${paddingV}px ${paddingH}px`,
          boxShadow,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          overflow: clipContent ? 'hidden' : 'visible',
        }}
      >
        <div
          style={{
            fontSize: titleFontSize,
            fontWeight: titleWeight,
            color: titleColor,
            textAlign: titleAlign,
            fontFamily: titleFont,
            lineHeight: titleLineHeight,
            letterSpacing: titleLetterSpacing,
          }}
        >
          {title || 'Card Title'}
        </div>
        <div
          style={{
            flex: 1,
            borderRadius: Math.max(4, cornerRadius - 4),
            border: `1px dashed ${strokePaint}`,
            background: `color-mix(in srgb, ${fillMain} 35%, var(--bg-panel))`,
          }}
        />
      </HTMLContainer>
    )
  }

  indicator(shape: CardShape) {
    const { w, h } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 14
    return <rect width={Math.max(1, w)} height={Math.max(1, h)} rx={cornerRadius} ry={cornerRadius} />
  }
}
