import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import { TEXT_BLOCK_DEFAULT_PADDING, TEXT_BLOCK_DEFAULT_PROPS, type TextBlockShape } from './types'

export class TextBlockShapeUtil extends BaseBoxShapeUtil<TextBlockShape> {
  static type = 'ui-text-block' as const
  static props = {
    w: T.number,
    h: T.number,
    content: T.string,
    fontSize: T.number,
    color: T.string,
  }

  getDefaultProps(): TextBlockShape['props'] {
    return { ...TEXT_BLOCK_DEFAULT_PROPS }
  }

  component(shape: TextBlockShape) {
    const { w, h, content, fontSize, color } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const lineHeight = typeof meta.readyLineHeight === 'number' && meta.readyLineHeight > 0
      ? `${meta.readyLineHeight}px`
      : '1.45'
    const letterSpacing = typeof meta.readyLetterSpacing === 'number' ? `${meta.readyLetterSpacing}px` : undefined
    const fontWeight = meta.readyFontWeight === 'bold' ? 700 : meta.readyFontWeight === 'medium' ? 500 : 400
    const fontFamily = meta.readyFontFamily === 'serif'
      ? 'ui-serif, Georgia, serif'
      : meta.readyFontFamily === 'mono'
        ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
        : meta.readyFontFamily === 'draw'
          ? "'Comic Sans MS', cursive"
          : 'inherit'
    const textAlign = meta.readyTextAlign === 'middle' ? 'center' : meta.readyTextAlign === 'end' ? 'right' : 'left'
    const justifyContent = meta.readyVerticalAlign === 'start'
      ? 'flex-start'
      : meta.readyVerticalAlign === 'end'
        ? 'flex-end'
        : 'center'
    const strokeColor = typeof meta.readyStrokeColor === 'string' ? String(meta.readyStrokeColor) : 'transparent'
    const strokeOpacity = typeof meta.readyStrokeOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyStrokeOpacity))) : 100
    const strokeWidth = typeof meta.readyStrokeWidth === 'number' ? Math.max(0, Number(meta.readyStrokeWidth)) : 0
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
    const fillStyle = typeof meta.readyFillStyle === 'string' ? meta.readyFillStyle : 'solid'
    const fillVisible = meta.readyFillVisible !== false && fillStyle !== 'none'
    const fillOpacity = typeof meta.readyFillOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyFillOpacity))) : 100
    const fillColor = typeof meta.readyFillColor === 'string' ? String(meta.readyFillColor) : 'transparent'
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 6
    const clipContent = meta.readyClipContent === true
    const paddingH = typeof meta.readyPaddingH === 'number'
      ? Math.max(0, Number(meta.readyPaddingH))
      : TEXT_BLOCK_DEFAULT_PADDING.horizontal
    const paddingV = typeof meta.readyPaddingV === 'number'
      ? Math.max(0, Number(meta.readyPaddingV))
      : TEXT_BLOCK_DEFAULT_PADDING.vertical
    const textColor = typeof meta.readyTextColor === 'string' ? String(meta.readyTextColor) : (color || 'var(--text-title)')
    const shadowEnabled = meta.readyDropShadowEnabled === true
    const shadowColor = typeof meta.readyDropShadowColor === 'string' ? String(meta.readyDropShadowColor) : '#000000'
    const shadowOpacity = typeof meta.readyDropShadowOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyDropShadowOpacity))) : 0
    const shadowBlur = typeof meta.readyDropShadowBlur === 'number' ? Math.max(0, Number(meta.readyDropShadowBlur)) : 0
    const shadowX = typeof meta.readyDropShadowX === 'number' ? Number(meta.readyDropShadowX) : 0
    const shadowY = typeof meta.readyDropShadowY === 'number' ? Number(meta.readyDropShadowY) : 2
    const shadowHex = shadowColor.startsWith('#') ? shadowColor.slice(0, 7) : '#000000'
    const shadowAlpha = Math.round((shadowOpacity / 100) * 255).toString(16).padStart(2, '0')
    const shadow = shadowEnabled && shadowBlur > 0
      ? `${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowHex}${shadowAlpha}`
      : 'none'
    const strokePaint = `color-mix(in srgb, ${strokeColor} ${strokeOpacity}%, transparent)`
    const fillMain = `color-mix(in srgb, ${fillColor} ${fillOpacity}%, transparent)`
    const fillSoft = `color-mix(in srgb, ${fillColor} ${Math.max(0, Math.round(fillOpacity * 0.62))}%, white)`
    const border = strokeVisible && strokeWidth > 0 && strokePosition !== 'outside'
      ? `${strokeWidth}px ${strokeDash} ${strokePaint}`
      : 'none'
    const outsideStroke = strokeVisible && strokePosition === 'outside' && strokeWidth > 0
      ? `0 0 0 ${strokeWidth}px ${strokePaint}`
      : ''
    const computedFill = fillVisible
      ? fillStyle === 'semi'
        ? fillSoft
        : fillStyle === 'pattern'
          ? `repeating-linear-gradient(135deg, ${fillMain}, ${fillMain} 8px, ${fillSoft} 8px, ${fillSoft} 16px)`
          : fillStyle === 'lined-fill'
            ? `repeating-linear-gradient(90deg, ${fillSoft}, ${fillSoft} 3px, ${fillMain} 3px, ${fillMain} 6px)`
            : fillMain
      : 'transparent'

    return (
      <HTMLContainer
        style={{
          width: Math.max(40, w),
          height: Math.max(20, h),
          boxSizing: 'border-box',
          padding: `${paddingV}px ${paddingH}px`,
          fontSize: Math.max(10, fontSize),
          lineHeight,
          letterSpacing,
          fontWeight,
          fontFamily,
          textAlign,
          color: textColor,
          border,
          borderRadius: cornerRadius,
          background: computedFill,
          display: 'flex',
          alignItems: justifyContent,
          whiteSpace: 'pre-wrap',
          overflow: clipContent ? 'hidden' : 'visible',
          wordBreak: 'break-word',
          boxShadow: [outsideStroke, shadow].filter(Boolean).join(', ') || 'none',
        }}
      >
        {content || 'Text content'}
      </HTMLContainer>
    )
  }

  indicator(shape: TextBlockShape) {
    const { w, h } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 6
    return <rect width={Math.max(1, w)} height={Math.max(1, h)} rx={cornerRadius} ry={cornerRadius} />
  }
}
