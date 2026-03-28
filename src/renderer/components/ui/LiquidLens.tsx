import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'

export interface LiquidLensProps {
  variant: 'pill' | 'field' | 'tray'
  radius: number
  padding?: string
  style?: CSSProperties
  className?: string
  intensity?: number
  elasticity?: number
  followPointer?: boolean
  interactive?: boolean
  children: ReactNode
}

interface LiquidLensFrame {
  x: number
  y: number
  hover: number
  press: number
}

interface LensSize {
  width: number
  height: number
}

const IDLE_FRAME: LiquidLensFrame = { x: 0, y: 0, hover: 0, press: 0 }
const IDLE_SIZE: LensSize = { width: 0, height: 0 }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount
}

function getVariantDefaults(variant: LiquidLensProps['variant']) {
  if (variant === 'pill') {
    return {
      intensity: 1,
      elasticity: 0.34,
      followPointer: true,
      blur: 18,
      shadow: '0 10px 22px rgba(61, 88, 148, 0.22)',
      tint: 'rgba(255,255,255,0.018)',
    }
  }

  if (variant === 'field') {
    return {
      intensity: 0.74,
      elasticity: 0.16,
      followPointer: true,
      blur: 20,
      shadow: '0 12px 22px rgba(56, 84, 138, 0.18)',
      tint: 'rgba(255,255,255,0.014)',
    }
  }

  return {
    intensity: 0.82,
    elasticity: 0.12,
    followPointer: true,
    blur: 22,
    shadow: '0 14px 28px rgba(51, 78, 132, 0.18)',
    tint: 'rgba(255,255,255,0.012)',
  }
}

function createDisplacementDataUrl(
  variant: LiquidLensProps['variant'],
  frame: LiquidLensFrame,
  intensity: number,
): string {
  const edgeStart = variant === 'field' ? 64 : variant === 'tray' ? 58 : 50
  const edgeMid = variant === 'field' ? 84 : variant === 'tray' ? 80 : 74
  const xCenter = 50 + frame.x * 9
  const yCenter = 50 + frame.y * 9
  const outerX = Math.round(clamp(128 + frame.x * 72 * intensity, 68, 196))
  const outerY = Math.round(clamp(128 + frame.y * 72 * intensity, 68, 196))
  const innerX = Math.round(clamp(128 - frame.x * 34 * intensity, 88, 164))
  const innerY = Math.round(clamp(128 - frame.y * 34 * intensity, 88, 164))
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">
      <defs>
        <radialGradient id="g" cx="${xCenter}%" cy="${yCenter}%" r="68%">
          <stop offset="0%" stop-color="rgb(128,128,128)" />
          <stop offset="${edgeStart}%" stop-color="rgb(128,128,128)" />
          <stop offset="${edgeMid}%" stop-color="rgb(${innerX},128,${innerY})" />
          <stop offset="100%" stop-color="rgb(${outerX},128,${outerY})" />
        </radialGradient>
      </defs>
      <rect width="100" height="100" fill="url(#g)" />
    </svg>
  `

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function GlassFilter({
  id,
  displacementScale,
  aberrationIntensity,
  width,
  height,
  mapUrl,
}: {
  id: string
  displacementScale: number
  aberrationIntensity: number
  width: number
  height: number
  mapUrl: string
}) {
  return (
    <svg
      aria-hidden="true"
      style={{ position: 'absolute', width, height, pointerEvents: 'none', overflow: 'hidden' }}
    >
      <defs>
        <radialGradient id={`${id}-edge-mask`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="black" stopOpacity="0" />
          <stop offset={`${Math.max(34, 82 - aberrationIntensity * 3)}%`} stopColor="black" stopOpacity="0" />
          <stop offset="100%" stopColor="white" stopOpacity="1" />
        </radialGradient>
        <filter id={id} x="-36%" y="-36%" width="172%" height="172%" colorInterpolationFilters="sRGB">
          <feImage
            x="0"
            y="0"
            width="100%"
            height="100%"
            result="DISPLACEMENT_MAP"
            href={mapUrl}
            preserveAspectRatio="none"
          />

          <feColorMatrix
            in="DISPLACEMENT_MAP"
            type="matrix"
            values="0.3 0.3 0.3 0 0
                    0.3 0.3 0.3 0 0
                    0.3 0.3 0.3 0 0
                    0 0 0 1 0"
            result="EDGE_INTENSITY"
          />
          <feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK">
            <feFuncA type="discrete" tableValues={`0 ${Math.max(0.08, aberrationIntensity * 0.06)} 1`} />
          </feComponentTransfer>

          <feOffset in="SourceGraphic" dx="0" dy="0" result="CENTER_ORIGINAL" />

          <feDisplacementMap
            in="SourceGraphic"
            in2="DISPLACEMENT_MAP"
            scale={-displacementScale}
            xChannelSelector="R"
            yChannelSelector="B"
            result="RED_DISPLACED"
          />
          <feColorMatrix
            in="RED_DISPLACED"
            type="matrix"
            values="1 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="RED_CHANNEL"
          />

          <feDisplacementMap
            in="SourceGraphic"
            in2="DISPLACEMENT_MAP"
            scale={-(displacementScale - aberrationIntensity * 2.6)}
            xChannelSelector="R"
            yChannelSelector="B"
            result="GREEN_DISPLACED"
          />
          <feColorMatrix
            in="GREEN_DISPLACED"
            type="matrix"
            values="0 0 0 0 0
                    0 1 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="GREEN_CHANNEL"
          />

          <feDisplacementMap
            in="SourceGraphic"
            in2="DISPLACEMENT_MAP"
            scale={-(displacementScale - aberrationIntensity * 4.2)}
            xChannelSelector="R"
            yChannelSelector="B"
            result="BLUE_DISPLACED"
          />
          <feColorMatrix
            in="BLUE_DISPLACED"
            type="matrix"
            values="0 0 0 0 0
                    0 0 0 0 0
                    0 0 1 0 0
                    0 0 0 1 0"
            result="BLUE_CHANNEL"
          />

          <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
          <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />
          <feGaussianBlur
            in="RGB_COMBINED"
            stdDeviation={Math.max(0.15, 0.7 - aberrationIntensity * 0.08)}
            result="ABERRATED_BLURRED"
          />
          <feComposite in="ABERRATED_BLURRED" in2="EDGE_MASK" operator="in" result="EDGE_ABERRATION" />

          <feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK">
            <feFuncA type="table" tableValues="1 0" />
          </feComponentTransfer>
          <feComposite in="CENTER_ORIGINAL" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN" />
          <feComposite in="EDGE_ABERRATION" in2="CENTER_CLEAN" operator="over" />
        </filter>
      </defs>
    </svg>
  )
}

export default function LiquidLens({
  variant,
  radius,
  padding = '0',
  style,
  className,
  intensity,
  elasticity,
  followPointer,
  interactive = true,
  children,
}: LiquidLensProps) {
  const reduceMotion = useReducedMotion()
  const defaults = getVariantDefaults(variant)
  const resolvedIntensity = intensity ?? defaults.intensity
  const resolvedElasticity = elasticity ?? defaults.elasticity
  const resolvedFollowPointer = followPointer ?? defaults.followPointer
  const frameRef = useRef<LiquidLensFrame>(IDLE_FRAME)
  const targetRef = useRef<LiquidLensFrame>(IDLE_FRAME)
  const [frame, setFrame] = useState<LiquidLensFrame>(IDLE_FRAME)
  const [lensSize, setLensSize] = useState<LensSize>(IDLE_SIZE)
  const shellRef = useRef<HTMLDivElement>(null)
  const filterId = useId().replace(/:/g, '')

  useEffect(() => {
    if (!interactive || reduceMotion) return

    let rafId = 0

    const tick = () => {
      const current = frameRef.current
      const target = targetRef.current
      const next = {
        x: lerp(current.x, target.x, 0.16),
        y: lerp(current.y, target.y, 0.16),
        hover: lerp(current.hover, target.hover, 0.18),
        press: lerp(current.press, target.press, 0.24),
      }

      frameRef.current = next
      setFrame(next)
      rafId = window.requestAnimationFrame(tick)
    }

    rafId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(rafId)
  }, [interactive, reduceMotion])

  useEffect(() => {
    if (!shellRef.current) return

    const updateSize = () => {
      const rect = shellRef.current?.getBoundingClientRect()
      if (!rect) return
      setLensSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      })
    }

    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(shellRef.current)
    window.addEventListener('resize', updateSize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateSize)
    }
  }, [])

  const updatePointerTarget = (clientX: number, clientY: number) => {
    if (!resolvedFollowPointer || !shellRef.current) {
      targetRef.current = { ...targetRef.current, x: 0, y: 0 }
      return
    }

    const rect = shellRef.current.getBoundingClientRect()
    const nextX = clamp(((clientX - rect.left) / rect.width) * 2 - 1, -1, 1)
    const nextY = clamp(((clientY - rect.top) / rect.height) * 2 - 1, -1, 1)
    targetRef.current = { ...targetRef.current, x: nextX, y: nextY }
  }

  const activeAmount = clamp(0.6 + frame.hover * 0.95 + frame.press * 1.15, 0.42, 2.36)
  const displacementScale = reduceMotion
    ? 0
    : Math.round((variant === 'pill' ? 74 : variant === 'field' ? 56 : 46) * resolvedIntensity * activeAmount)
  const mapUrl = createDisplacementDataUrl(variant, frame, resolvedIntensity * activeAmount)
  const aberrationIntensity = reduceMotion
    ? 0
    : (variant === 'pill' ? 5.6 : variant === 'field' ? 4.1 : 3.2) * activeAmount
  const translateX = reduceMotion ? 0 : frame.x * resolvedElasticity * 20 * frame.hover
  const translateY = reduceMotion ? 0 : frame.y * resolvedElasticity * 15 * frame.hover
  const stretchX = reduceMotion ? 1 : 1 + Math.abs(frame.x) * resolvedElasticity * 0.28 * activeAmount
  const stretchY = reduceMotion ? 1 : 1 + Math.abs(frame.y) * resolvedElasticity * 0.22 * activeAmount
  const pressScale = reduceMotion ? 1 : 1 - frame.press * 0.034
  const highlightAngle = 132 + frame.x * 38 + frame.y * 16
  const highlightOpacity = 0.18 + frame.hover * 0.22 + frame.press * 0.16
  const chromaOpacity = 0.08 + frame.hover * 0.12 + frame.press * 0.05

  return (
    <div
      ref={shellRef}
      className={className}
      style={{
        position: 'relative',
        display: variant === 'pill' ? 'inline-flex' : 'block',
        width: variant === 'pill' ? style?.width : '100%',
        minWidth: 0,
        isolation: 'isolate',
        ...style,
      }}
      onPointerEnter={() => {
        if (!interactive) return
        targetRef.current = { ...targetRef.current, hover: 1 }
      }}
      onPointerMove={(event) => {
        if (!interactive) return
        updatePointerTarget(event.clientX, event.clientY)
      }}
      onPointerLeave={() => {
        if (!interactive) return
        targetRef.current = { ...IDLE_FRAME }
      }}
      onPointerDown={(event) => {
        if (!interactive) return
        updatePointerTarget(event.clientX, event.clientY)
        targetRef.current = { ...targetRef.current, press: 1, hover: 1 }
      }}
      onPointerUp={() => {
        if (!interactive) return
        targetRef.current = { ...targetRef.current, press: 0 }
      }}
      onPointerCancel={() => {
        if (!interactive) return
        targetRef.current = { ...IDLE_FRAME }
      }}
    >
      <GlassFilter
        id={filterId}
        displacementScale={displacementScale}
        aberrationIntensity={aberrationIntensity}
        width={lensSize.width}
        height={lensSize.height}
        mapUrl={mapUrl}
      />

      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          borderRadius: radius,
          pointerEvents: 'none',
          boxShadow: defaults.shadow,
        }}
      >
        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: radius,
            background: defaults.tint,
            filter: `url(#${filterId})`,
            backdropFilter: `blur(${defaults.blur + frame.hover * 9}px) saturate(${174 + frame.hover * 54}%)`,
            WebkitBackdropFilter: `blur(${defaults.blur + frame.hover * 9}px) saturate(${174 + frame.hover * 54}%)`,
            opacity: 1,
            transform: `translate3d(${translateX}px, ${translateY}px, 0) scaleX(${stretchX}) scaleY(${stretchY}) scale(${pressScale})`,
            transition: reduceMotion ? 'none' : 'opacity 120ms ease-out',
          }}
        />

        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: radius,
            pointerEvents: 'none',
            padding: variant === 'pill' ? 1.15 : 1.3,
            WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
            WebkitMaskComposite: 'xor',
            maskComposite: 'exclude',
            mixBlendMode: 'screen',
            background: `linear-gradient(${highlightAngle}deg, rgba(255,255,255,0.02) 8%, rgba(255,255,255,0.96) 40%, rgba(255,255,255,0.12) 82%)`,
            boxShadow: '0 0 0 0.8px rgba(255,255,255,0.52) inset, 0 1px 5px rgba(255,255,255,0.28) inset, 0 2px 8px rgba(15, 23, 42, 0.24)',
            opacity: 0.84 + frame.hover * 0.14,
          }}
        />

        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: radius,
            pointerEvents: 'none',
            padding: variant === 'pill' ? 1.15 : 1.3,
            WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
            WebkitMaskComposite: 'xor',
            maskComposite: 'exclude',
            mixBlendMode: 'overlay',
            opacity: chromaOpacity,
            background: `linear-gradient(${highlightAngle + 18}deg, rgba(110,170,255,0.42) 14%, rgba(255,255,255,0) 40%, rgba(255,196,132,0.36) 82%)`,
          }}
        />

        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: radius,
            pointerEvents: 'none',
            mixBlendMode: 'overlay',
            opacity: highlightOpacity,
            backgroundImage: `radial-gradient(circle at ${50 + frame.x * 14}% ${18 + frame.y * 10}%, rgba(255, 255, 255, 0.96) 0%, rgba(255, 255, 255, 0) 42%)`,
          }}
        />

        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: radius,
            pointerEvents: 'none',
            mixBlendMode: 'overlay',
            opacity: frame.press * 0.56,
            backgroundImage: `radial-gradient(circle at ${50 + frame.x * 18}% ${16 + frame.y * 12}%, rgba(255, 255, 255, 1) 0%, rgba(255, 255, 255, 0) 72%)`,
          }}
        />
      </span>

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          padding,
          minWidth: 0,
          transform: `translate3d(${translateX * 0.4}px, ${translateY * 0.4}px, 0) scale(${1 - frame.press * 0.012})`,
          transformOrigin: 'center',
        }}
      >
        {children}
      </div>
    </div>
  )
}
