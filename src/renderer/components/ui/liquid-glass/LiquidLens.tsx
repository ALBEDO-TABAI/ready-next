import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { buildRefractionMap } from './refraction-map'

/**
 * Real refractive liquid-glass surface.
 *
 * A canvas-generated, physically derived displacement map (see
 * refraction-map.ts) feeds an SVG feDisplacementMap that Chromium applies to
 * the live backdrop via `backdrop-filter: url(#…)`. The interior stays
 * optically flat; the edge band bends the backdrop like a glass bevel.
 *
 * Chromium-only by design (Electron renderer). The map regenerates on
 * geometry changes; strength/blur/saturation/aberration apply live without
 * regeneration.
 */
export interface LiquidLensProps {
  /** Corner radius in CSS px. */
  radius: number
  /** Refracting edge band width in CSS px. */
  bevel?: number
  /** Optical glass thickness in CSS px — how far the edge bends light. */
  depth?: number
  /** Index of refraction (glass ≈ 1.5). */
  ior?: number
  /**
   * Interior dome curvature in CSS px. 0 = flat slab (only the bevel band
   * refracts); >0 bows the whole surface so the center gently magnifies —
   * the "thick glass" feel.
   */
  dome?: number
  /** Extra multiplier on the physical displacement, 1 = physical. */
  strength?: number
  /** Backdrop blur in px, applied after refraction. */
  blur?: number
  /**
   * Liquid frost: turbulence-displacement that smears the backdrop into
   * flowing streaks plus fine grain, in px of scatter. 0 = off.
   */
  frost?: number
  /** Run the blur before the lens displacement so text turns to mist before the bevel bends it. */
  blurBeforeRefraction?: boolean
  /** Backdrop saturation, 1 = neutral. */
  saturation?: number
  /** Backdrop brightness, 1 = neutral. */
  brightness?: number
  /** Backdrop contrast, 1 = neutral. */
  contrast?: number
  /**
   * Chromatic aberration: per-channel displacement spread in px.
   * Only use over OPAQUE backdrops. The per-channel recombination cannot
   * preserve premultiplied alpha, so on translucent surfaces (native
   * vibrancy windows) any value > 0 collapses the backdrop to ~1/3
   * brightness. Default 0.
   */
  aberration?: number
  /**
   * How the displacement reaches the backdrop.
   * 'backdrop': backdrop-filter: url(#f) — single clean pass.
   * 'layer': filter: url(#f) on a layer that carries backdrop-filter blur —
   * the liquid-glass-react trick, kept as a fallback switch.
   */
  engine?: 'backdrop' | 'layer'
  /** Render the displacement map for inspection. */
  debugMap?: boolean
  className?: string
  style?: CSSProperties
  backdropContent?: ReactNode
  children?: ReactNode
}

interface LensMap {
  url: string
  cssWidth: number
  cssHeight: number
  maxDisplacement: number
  generation: number
}

// Monotonic across all instances: every regenerated map gets a fresh filter
// id, since Chromium does not reliably re-snapshot backdrop-filter when an
// SVG filter mutates in place.
let mapGeneration = 0

export function LiquidLens({
  radius,
  bevel = 20,
  depth = 10,
  ior = 1.5,
  dome = 0,
  strength = 1,
  blur = 2,
  frost = 0,
  blurBeforeRefraction = false,
  saturation = 1.1,
  brightness = 1,
  contrast = 1,
  aberration = 0,
  engine = 'backdrop',
  debugMap = false,
  className,
  style,
  backdropContent,
  children,
}: LiquidLensProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [map, setMap] = useState<LensMap | null>(null)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    let frame = 0
    let lastKey = ''

    const regenerate = () => {
      frame = 0
      const rect = host.getBoundingClientRect()
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      if (width < 8 || height < 8) return
      const key = `${width}x${height}`
      if (key === lastKey) return
      lastKey = key

      const resolution = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
      const built = buildRefractionMap({ width, height, radius, bevel, depth, ior, dome, resolution })
      const canvas = document.createElement('canvas')
      canvas.width = built.pixelWidth
      canvas.height = built.pixelHeight
      const context = canvas.getContext('2d')
      if (!context) return
      context.putImageData(new ImageData(built.data, built.pixelWidth, built.pixelHeight), 0, 0)
      mapGeneration += 1
      setMap({
        url: canvas.toDataURL('image/png'),
        cssWidth: width,
        cssHeight: height,
        maxDisplacement: built.maxDisplacement,
        generation: mapGeneration,
      })
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(regenerate)
    }
    schedule()
    // jsdom-based render tests have no ResizeObserver; the lens then simply
    // stays at its last generated map (none, for 0×0 rects).
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    observer?.observe(host)
    return () => {
      observer?.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [radius, bevel, depth, ior, dome])

  // Chromium never re-renders a bound backdrop reference filter when its
  // primitives mutate in place — every graph-affecting param must be part of
  // the id so changes force a re-bind.
  const filterKey = `${map?.generation ?? 0}-${strength}-${aberration}-${frost}`.replace(/\./g, '_')
  const filterId = map ? `liquid-lens-${uid}-${filterKey}` : null
  const scale = map ? 2 * map.maxDisplacement * strength : 0
  const blurFn = `blur(${blur}px)`
  const colorFns = `saturate(${saturation}) brightness(${brightness}) contrast(${contrast})`
  const finishFns = `${blurFn} ${colorFns}`

  const lensStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    borderRadius: radius,
    pointerEvents: 'none',
    zIndex: 1,
  }
  if (filterId && engine === 'backdrop') {
    const chain = blurBeforeRefraction
      ? `${blurFn} url(#${filterId}) ${colorFns}`
      : `url(#${filterId}) ${finishFns}`
    lensStyle.backdropFilter = chain
    lensStyle.WebkitBackdropFilter = chain
  } else {
    lensStyle.backdropFilter = finishFns
    lensStyle.WebkitBackdropFilter = finishFns
    if (filterId && engine === 'layer') {
      lensStyle.filter = `url(#${filterId})`
    }
  }

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ position: 'relative', borderRadius: radius, ...style }}
    >
      {map && filterId && (
        <svg aria-hidden="true" width={0} height={0} style={{ position: 'absolute' }}>
          <defs>
            <filter
              id={filterId}
              x="-20%"
              y="-20%"
              width="140%"
              height="140%"
              colorInterpolationFilters="sRGB"
            >
              <feImage
                href={map.url}
                x={0}
                y={0}
                width={map.cssWidth}
                height={map.cssHeight}
                preserveAspectRatio="none"
                result="map"
              />
              {aberration > 0 ? (
                <>
                  <feDisplacementMap
                    in="SourceGraphic"
                    in2="map"
                    scale={scale + aberration}
                    xChannelSelector="R"
                    yChannelSelector="G"
                    result="dispR"
                  />
                  <feColorMatrix
                    in="dispR"
                    type="matrix"
                    values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
                    result="chanR"
                  />
                  <feDisplacementMap
                    in="SourceGraphic"
                    in2="map"
                    scale={scale}
                    xChannelSelector="R"
                    yChannelSelector="G"
                    result="dispG"
                  />
                  <feColorMatrix
                    in="dispG"
                    type="matrix"
                    values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
                    result="chanG"
                  />
                  <feDisplacementMap
                    in="SourceGraphic"
                    in2="map"
                    scale={Math.max(0, scale - aberration)}
                    xChannelSelector="R"
                    yChannelSelector="G"
                    result="dispB"
                  />
                  <feColorMatrix
                    in="dispB"
                    type="matrix"
                    values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
                    result="chanB"
                  />
                  <feBlend in="chanR" in2="chanG" mode="screen" result="chanRG" />
                  <feBlend in="chanRG" in2="chanB" mode="screen" result="lensOut" />
                </>
              ) : (
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="map"
                  scale={scale}
                  xChannelSelector="R"
                  yChannelSelector="G"
                  result="lensOut"
                />
              )}
              {frost > 0 && (
                <>
                  {/* coarse anisotropic noise pulls horizontal liquid streaks */}
                  <feTurbulence
                    type="fractalNoise"
                    baseFrequency="0.012 0.15"
                    numOctaves={2}
                    seed={11}
                    result="frostCoarse"
                  />
                  <feDisplacementMap
                    in="lensOut"
                    in2="frostCoarse"
                    scale={frost * 2.2}
                    xChannelSelector="R"
                    yChannelSelector="G"
                    result="frostMid"
                  />
                  {/* fine grain scatter reads as ground glass */}
                  <feTurbulence
                    type="fractalNoise"
                    baseFrequency="0.85"
                    numOctaves={2}
                    seed={5}
                    result="frostFine"
                  />
                  <feDisplacementMap
                    in="frostMid"
                    in2="frostFine"
                    scale={frost * 0.7}
                    xChannelSelector="R"
                    yChannelSelector="G"
                  />
                </>
              )}
            </filter>
          </defs>
        </svg>
      )}
      {backdropContent != null && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 0,
            pointerEvents: 'none',
            filter: filterId ? `url(#${filterId})` : undefined,
          }}
        >
          {backdropContent}
        </div>
      )}
      <div aria-hidden="true" style={lensStyle} />
      {children != null && (
        <div style={{ position: 'relative', zIndex: 2 }}>{children}</div>
      )}
      {debugMap && map && (
        <img
          src={map.url}
          alt="displacement map"
          style={{
            position: 'absolute',
            left: 0,
            top: '100%',
            marginTop: 8,
            width: map.cssWidth,
            height: map.cssHeight,
            outline: '1px solid rgba(127,127,127,0.6)',
            zIndex: 10,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  )
}
