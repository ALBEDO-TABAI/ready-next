import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import { INPUT_DEFAULT_PROPS, type InputShape } from './types'

export class InputShapeUtil extends BaseBoxShapeUtil<InputShape> {
  static type = 'ui-input' as const
  static props = {
    w: T.number,
    h: T.number,
    label: T.string,
    placeholder: T.string,
    variant: T.literalEnum('default', 'filled'),
  }

  getDefaultProps(): InputShape['props'] {
    return { ...INPUT_DEFAULT_PROPS }
  }

  component(shape: InputShape) {
    const { w, h, label, placeholder, variant } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const fillStyle = typeof meta.readyFillStyle === 'string' ? meta.readyFillStyle : 'solid'
    const fillVisible = meta.readyFillVisible !== false && fillStyle !== 'none'
    const fillOpacity = typeof meta.readyFillOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyFillOpacity))) : 100
    const fillColor = typeof meta.readyFillColor === 'string'
      ? String(meta.readyFillColor)
      : variant === 'filled'
        ? 'var(--bg-panel)'
        : 'var(--bg-primary)'
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
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 8
    const fontWeight = meta.readyFontWeight === 'bold' ? 700 : meta.readyFontWeight === 'medium' ? 500 : 400
    const fontFamily = meta.readyFontFamily === 'serif'
      ? 'ui-serif, Georgia, serif'
      : meta.readyFontFamily === 'mono'
        ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
        : meta.readyFontFamily === 'draw'
          ? "'Comic Sans MS', cursive"
          : 'inherit'
    const lineHeight = typeof meta.readyLineHeight === 'number' && meta.readyLineHeight > 0
      ? `${meta.readyLineHeight}px`
      : '1.2'
    const letterSpacing = typeof meta.readyLetterSpacing === 'number' ? `${meta.readyLetterSpacing}px` : undefined
    const textAlign = meta.readyTextAlign === 'middle' ? 'center' : meta.readyTextAlign === 'end' ? 'right' : 'left'
    const textColor = typeof meta.readyTextColor === 'string' ? String(meta.readyTextColor) : 'var(--text-title)'
    const clipContent = meta.readyClipContent === true
    const strokePaint = `color-mix(in srgb, ${strokeColor} ${strokeOpacity}%, transparent)`
    const border = !strokeVisible || strokePosition === 'outside' ? 'none' : `${strokeWidth}px ${strokeDash} ${strokePaint}`
    const outsideStroke = strokeVisible && strokePosition === 'outside' && strokeWidth > 0 ? `0 0 0 ${strokeWidth}px ${strokePaint}` : ''
    const shadowEnabled = meta.readyDropShadowEnabled === true
    const shadowColor = typeof meta.readyDropShadowColor === 'string' ? String(meta.readyDropShadowColor) : '#000000'
    const shadowOpacity = typeof meta.readyDropShadowOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyDropShadowOpacity))) : 0
    const shadowBlur = typeof meta.readyDropShadowBlur === 'number' ? Math.max(0, Number(meta.readyDropShadowBlur)) : 0
    const shadowX = typeof meta.readyDropShadowX === 'number' ? Number(meta.readyDropShadowX) : 0
    const shadowY = typeof meta.readyDropShadowY === 'number' ? Number(meta.readyDropShadowY) : 4
    const shadowHex = shadowColor.startsWith('#') ? shadowColor.slice(0, 7) : '#000000'
    const shadowAlpha = Math.round((shadowOpacity / 100) * 255).toString(16).padStart(2, '0')
    const shadow = shadowEnabled && shadowBlur > 0
      ? `${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowHex}${shadowAlpha}`
      : 'none'
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

    return (
      <HTMLContainer
        style={{
          width: Math.max(60, w),
          height: Math.max(24, h),
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 6,
          color: textColor,
          fontFamily: 'inherit',
          overflow: clipContent ? 'hidden' : 'visible',
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: 'color-mix(in srgb, var(--text-muted) 86%, black)', textAlign }}>{label || 'Label'}</div>
        <div
          style={{
            flex: 1,
            minHeight: 26,
            borderRadius: cornerRadius,
            padding: '8px 10px',
            boxSizing: 'border-box',
            border,
            boxShadow,
            background: computedFill,
            fontSize: 12,
            color: `color-mix(in srgb, ${textColor} 70%, var(--text-muted))`,
            display: 'flex',
            alignItems: 'center',
            fontWeight,
            fontFamily,
            lineHeight,
            letterSpacing,
            textAlign,
          }}
        >
          {placeholder || 'Input placeholder'}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: InputShape) {
    const { w, h } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 8
    return <rect width={Math.max(1, w)} height={Math.max(1, h)} rx={cornerRadius} ry={cornerRadius} />
  }
}
