import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import { BUTTON_DEFAULT_PROPS, type ButtonShape } from './types'

export class ButtonShapeUtil extends BaseBoxShapeUtil<ButtonShape> {
  static type = 'ui-button' as const
  static props = {
    w: T.number,
    h: T.number,
    label: T.string,
    variant: T.literalEnum('primary', 'secondary', 'ghost'),
    cornerRadius: T.number,
  }

  getDefaultProps(): ButtonShape['props'] {
    return { ...BUTTON_DEFAULT_PROPS }
  }

  component(shape: ButtonShape) {
    const { w, h, label, variant, cornerRadius } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>

    const variants: Record<ButtonShape['props']['variant'], { background: string; color: string; border: string }> = {
      primary: {
        background: 'var(--color-blue)',
        color: '#FFFFFF',
        border: '1px solid transparent',
      },
      secondary: {
        background: 'var(--bg-panel)',
        color: 'var(--text-title)',
        border: '1px solid var(--border-default)',
      },
      ghost: {
        background: 'transparent',
        color: 'var(--text-title)',
        border: '1px dashed var(--border-default)',
      },
    }

    const fillStyle = typeof meta.readyFillStyle === 'string' ? meta.readyFillStyle : 'solid'
    const fillVisible = meta.readyFillVisible !== false && fillStyle !== 'none'
    const fillOpacity = typeof meta.readyFillOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyFillOpacity))) : 100
    const fillColor = typeof meta.readyFillColor === 'string' ? String(meta.readyFillColor) : variants[variant].background
    const textColor = typeof meta.readyTextColor === 'string' ? String(meta.readyTextColor) : variants[variant].color
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
    const fontWeight = meta.readyFontWeight === 'bold' ? 700 : meta.readyFontWeight === 'medium' ? 600 : 600
    const fontSize = typeof meta.readyFontSize === 'number' ? Math.max(10, Number(meta.readyFontSize)) : 13
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
    const letterSpacing = typeof meta.readyLetterSpacing === 'number' ? `${meta.readyLetterSpacing}px` : '0.01em'
    const textAlign = meta.readyTextAlign === 'middle' ? 'center' : meta.readyTextAlign === 'end' ? 'right' : 'left'
    const justifyContent = meta.readyVerticalAlign === 'start'
      ? 'flex-start'
      : meta.readyVerticalAlign === 'end'
        ? 'flex-end'
        : 'center'
    const clipContent = meta.readyClipContent === true
    const shadowEnabled = meta.readyDropShadowEnabled === true
    const shadowColor = typeof meta.readyDropShadowColor === 'string' ? String(meta.readyDropShadowColor) : '#000000'
    const shadowOpacity = typeof meta.readyDropShadowOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyDropShadowOpacity))) : 20
    const shadowBlur = typeof meta.readyDropShadowBlur === 'number' ? Math.max(0, Number(meta.readyDropShadowBlur)) : 8
    const shadowX = typeof meta.readyDropShadowX === 'number' ? Number(meta.readyDropShadowX) : 0
    const shadowY = typeof meta.readyDropShadowY === 'number' ? Number(meta.readyDropShadowY) : 4
    const shadowHex = shadowColor.startsWith('#') ? shadowColor.slice(0, 7) : '#000000'
    const shadowAlpha = Math.round((shadowOpacity / 100) * 255).toString(16).padStart(2, '0')
    const shadow = shadowEnabled && shadowBlur > 0
      ? `${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowHex}${shadowAlpha}`
      : 'none'
    const resolvedCornerRadius = typeof meta.readyCornerRadius === 'number'
      ? Math.max(0, Number(meta.readyCornerRadius))
      : Math.max(0, cornerRadius)
    const strokePaint = `color-mix(in srgb, ${strokeColor} ${strokeOpacity}%, transparent)`
    const fillMain = `color-mix(in srgb, ${fillColor} ${fillOpacity}%, transparent)`
    const fillSoft = `color-mix(in srgb, ${fillColor} ${Math.max(0, Math.round(fillOpacity * 0.62))}%, white)`
    const border = !strokeVisible || strokePosition === 'outside' ? 'none' : `${strokeWidth}px ${strokeDash} ${strokePaint}`
    const outsideStroke = strokeVisible && strokePosition === 'outside' && strokeWidth > 0 ? `0 0 0 ${strokeWidth}px ${strokePaint}` : ''
    const boxShadow = [outsideStroke, shadow].filter(Boolean).join(', ') || 'none'
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
          width: Math.max(24, w),
          height: Math.max(20, h),
          borderRadius: resolvedCornerRadius,
          display: 'flex',
          alignItems: justifyContent,
          justifyContent: 'center',
          textAlign,
          fontSize,
          fontWeight,
          fontFamily,
          lineHeight,
          letterSpacing,
          boxSizing: 'border-box',
          color: textColor,
          background: computedFill,
          border,
          boxShadow,
          overflow: clipContent ? 'hidden' : 'visible',
        }}
      >
        {label || 'Button'}
      </HTMLContainer>
    )
  }

  indicator(shape: ButtonShape) {
    const { w, h, cornerRadius } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const resolvedCornerRadius = typeof meta.readyCornerRadius === 'number'
      ? Math.max(0, Number(meta.readyCornerRadius))
      : Math.max(0, cornerRadius)
    return <rect width={Math.max(1, w)} height={Math.max(1, h)} rx={resolvedCornerRadius} ry={resolvedCornerRadius} />
  }
}
