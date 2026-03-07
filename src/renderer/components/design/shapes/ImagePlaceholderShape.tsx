import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import { IMAGE_PLACEHOLDER_DEFAULT_PROPS, type ImagePlaceholderShape } from './types'

export class ImagePlaceholderShapeUtil extends BaseBoxShapeUtil<ImagePlaceholderShape> {
  static type = 'ui-image-placeholder' as const
  static props = {
    w: T.number,
    h: T.number,
    label: T.string,
    aspectRatio: T.literalEnum('16:9', '4:3', '1:1'),
  }

  getDefaultProps(): ImagePlaceholderShape['props'] {
    return { ...IMAGE_PLACEHOLDER_DEFAULT_PROPS }
  }

  component(shape: ImagePlaceholderShape) {
    const { w, h, label, aspectRatio } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const fillStyle = typeof meta.readyFillStyle === 'string' ? meta.readyFillStyle : 'solid'
    const fillVisible = meta.readyFillVisible !== false && fillStyle !== 'none'
    const fillOpacity = typeof meta.readyFillOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyFillOpacity))) : 100
    const fillColor = typeof meta.readyFillColor === 'string' ? String(meta.readyFillColor) : 'var(--bg-panel)'
    const strokeColor = typeof meta.readyStrokeColor === 'string' ? String(meta.readyStrokeColor) : 'var(--border-default)'
    const strokeOpacity = typeof meta.readyStrokeOpacity === 'number' ? Math.max(0, Math.min(100, Number(meta.readyStrokeOpacity))) : 100
    const strokeWidth = typeof meta.readyStrokeWidth === 'number' ? Math.max(0, Number(meta.readyStrokeWidth)) : 1
    const strokeVisible = meta.readyStrokeVisible !== false
    const strokeDash = meta.readyStrokeDash === 'dashed'
      ? 'dashed'
      : meta.readyStrokeDash === 'dotted'
        ? 'dotted'
        : 'dashed'
    const strokePosition = meta.readyStrokePosition === 'outside'
      ? 'outside'
      : meta.readyStrokePosition === 'inside'
        ? 'inside'
        : 'center'
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 10
    const textColor = typeof meta.readyTextColor === 'string' ? String(meta.readyTextColor) : 'var(--text-muted)'
    const clipContent = meta.readyClipContent === true
    const strokePaint = `color-mix(in srgb, ${strokeColor} ${strokeOpacity}%, transparent)`
    const border = !strokeVisible || strokePosition === 'outside' ? 'none' : `${strokeWidth}px ${strokeDash} ${strokePaint}`
    const outsideStroke = strokeVisible && strokePosition === 'outside' && strokeWidth > 0 ? `0 0 0 ${strokeWidth}px ${strokePaint}` : ''
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
    const usePatternBackground = fillStyle === 'pattern' || fillStyle === 'lined-fill'

    return (
      <HTMLContainer
        style={{
          width: Math.max(40, w),
          height: Math.max(40, h),
          boxSizing: 'border-box',
          border,
          borderRadius: cornerRadius,
          background: fillVisible
            ? usePatternBackground
              ? computedFill
              : `linear-gradient(135deg, color-mix(in srgb, ${computedFill} 78%, white) 0%, ${computedFill} 100%)`
            : 'transparent',
          position: 'relative',
          overflow: clipContent ? 'hidden' : 'visible',
          boxShadow: outsideStroke || 'none',
        }}
      >
        <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0 }}>
          <line x1="0" y1="0" x2="100" y2="100" stroke={strokePaint} strokeWidth="1.2" />
          <line x1="100" y1="0" x2="0" y2="100" stroke={strokePaint} strokeWidth="1.2" />
        </svg>
        <div
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 8,
            borderRadius: 6,
            padding: '4px 6px',
            backdropFilter: 'blur(4px)',
            background: `color-mix(in srgb, ${fillMain} 42%, white)`,
            fontSize: 10,
            color: textColor,
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span>{label || 'Image'}</span>
          <span>{aspectRatio}</span>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: ImagePlaceholderShape) {
    const { w, h } = shape.props
    const meta = (shape.meta || {}) as Record<string, unknown>
    const cornerRadius = typeof meta.readyCornerRadius === 'number' ? Math.max(0, Number(meta.readyCornerRadius)) : 10
    return (
      <g>
        <rect width={Math.max(1, w)} height={Math.max(1, h)} rx={cornerRadius} ry={cornerRadius} />
        <path d={`M0,0 L${Math.max(1, w)},${Math.max(1, h)} M${Math.max(1, w)},0 L0,${Math.max(1, h)}`} />
      </g>
    )
  }
}
