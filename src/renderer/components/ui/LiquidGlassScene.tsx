import {
  createContext,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useContext,
} from 'react'
import LiquidGlassImport from 'liquid-glass-react'

type LiquidGlassProps = {
  children: ReactNode
  displacementScale?: number
  blurAmount?: number
  saturation?: number
  aberrationIntensity?: number
  elasticity?: number
  cornerRadius?: number
  mouseContainer?: RefObject<HTMLElement | null> | null
  className?: string
  padding?: string
  style?: CSSProperties
  overLight?: boolean
  mode?: 'standard' | 'polar' | 'prominent' | 'shader'
  onClick?: () => void
}

export type LiquidGlassTone = 'button' | 'card' | 'panel'

interface LiquidGlassPrimitiveProps {
  id: string
  tone: LiquidGlassTone
  mouseContainer?: RefObject<HTMLDivElement | null> | null
  className?: string
  style?: CSSProperties
  innerClassName?: string
  innerStyle?: CSSProperties
  radius?: number
  children: ReactNode
}

const LiquidGlass = (
  (LiquidGlassImport as unknown as { default?: (props: LiquidGlassProps) => ReactElement }).default ??
  (LiquidGlassImport as unknown as (props: LiquidGlassProps) => ReactElement)
)

const LiquidSceneContext = createContext<RefObject<HTMLDivElement | null> | null>(null)

const NOISE_TEXTURE =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAiIGhlaWdodD0iMTYwIiB2aWV3Qm94PSIwIDAgMTYwIDE2MCI+PGZpbHRlciBpZD0ibiI+PGZlVHVyYnVsZW5jZSB0eXBlPSJmcmFjdGFsTm9pc2UiIGJhc2VGcmVxdWVuY3k9IjAuODUiIG51bU9jdGF2ZXM9IjIiIHN0aXRjaFRpbGVzPSJzdGl0Y2giLz48ZmVDb2xvck1hdHJpeCB0eXBlPSJzYXR1cmF0ZSIgdmFsdWVzPSIwIi8+PGZlQ29tcG9uZW50VHJhbnNmZXI+PGZlRnVuY0EgdHlwZT0idGFibGUiIHRhYmxlVmFsdWVzPSIwIDAuNDUiLz48L2ZlQ29tcG9uZW50VHJhbnNmZXI+PC9maWx0ZXI+PHJlY3Qgd2lkdGg9IjE2MCIgaGVpZ2h0PSIxNjAiIGZpbHRlcj0idXJsKCNuKSIgb3BhY2l0eT0iMC45Ii8+PC9zdmc+'

// Displacement/aberration trimmed 2026-04-18: SVG filter pipeline is GPU-bound
// during backdrop blur stacking, and button/list tones gain almost no visual
// refraction from the extra magnitude. See
// docs/performance/2026-04-18-ui-animation-jank-gap-audit.md §G7.
const primitiveByTone: Record<LiquidGlassTone, Omit<LiquidGlassProps, 'children' | 'mouseContainer'>> = {
  button: {
    displacementScale: 60,
    blurAmount: 0.5,
    saturation: 140,
    aberrationIntensity: 0,
    elasticity: 0,
    cornerRadius: 32,
    mode: 'standard',
    padding: '0px',
  },
  card: {
    displacementScale: 70,
    blurAmount: 0.4,
    saturation: 140,
    aberrationIntensity: 1.2,
    elasticity: 0,
    cornerRadius: 30,
    mode: 'standard',
    padding: '0px',
  },
  panel: {
    displacementScale: 60,
    blurAmount: 0.36,
    saturation: 140,
    aberrationIntensity: 1.2,
    elasticity: 0,
    cornerRadius: 24,
    mode: 'standard',
    padding: '0px',
  },
}

export const LIQUID_TEXT_SHADOW = '0 2px 12px rgba(0, 0, 0, 0.42)'

export const LIQUID_PANEL_SHELL_STYLE: CSSProperties = {
  background: 'rgba(10, 14, 38, 0.16)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  boxShadow: '0 16px 46px rgba(0, 0, 0, 0.24)',
  backdropFilter: 'blur(20px) saturate(140%)',
  WebkitBackdropFilter: 'blur(20px) saturate(140%)',
}

export const LIQUID_CONTENT_SHELL_STYLE: CSSProperties = {
  background: 'rgba(13, 18, 46, 0.46)',
  borderColor: 'rgba(255,255,255,0.08)',
  boxShadow: '0 20px 58px rgba(0, 0, 0, 0.24)',
  backdropFilter: 'blur(16px) saturate(135%)',
  WebkitBackdropFilter: 'blur(16px) saturate(135%)',
}

export const LIQUID_CONTROL_PILL_STYLE: CSSProperties = {
  background: 'rgba(255,255,255,0.035)',
  borderColor: 'rgba(255,255,255,0.08)',
}

export const LIQUID_INACTIVE_CHROME_STYLE: CSSProperties = {
  background: 'rgba(255,255,255,0.018)',
  borderColor: 'rgba(255,255,255,0.08)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
  backdropFilter: 'blur(12px) saturate(140%)',
  WebkitBackdropFilter: 'blur(12px) saturate(140%)',
}

export const LIQUID_ICON_DISC_STYLE: CSSProperties = {
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
}

export function LiquidSceneProvider({
  mouseContainer,
  children,
}: {
  mouseContainer: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  return (
    <LiquidSceneContext.Provider value={mouseContainer}>
      {children}
    </LiquidSceneContext.Provider>
  )
}

export function useLiquidSceneContainer(): RefObject<HTMLDivElement | null> | null {
  return useContext(LiquidSceneContext)
}

export function LiquidBackdropScene({ scene = 'maxrovensky-inspired' }: { scene?: string }) {
  return (
    <div
      aria-hidden="true"
      data-scene={scene}
      className="pointer-events-none fixed inset-0 overflow-hidden"
    >
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(48% 52% at 16% 8%, rgba(10, 20, 136, 0.90), transparent 0 76%),
            radial-gradient(36% 44% at 79% 8%, rgba(112, 76, 255, 0.62), transparent 0 70%),
            radial-gradient(40% 44% at 64% 68%, rgba(22, 70, 180, 0.66), transparent 0 68%),
            linear-gradient(180deg, #03051d 0%, #08104a 42%, #07103b 100%)
          `,
        }}
      />
      <div
        className="absolute -left-[8%] top-[-14%] h-[58vw] w-[44vw] min-h-[460px] min-w-[340px] rounded-[44%]"
        style={{
          background: 'linear-gradient(180deg, rgba(255, 245, 255, 0.92) 0%, rgba(123, 108, 255, 0.26) 78%, rgba(255,255,255,0.0) 100%)',
          filter: 'blur(18px)',
          transform: 'rotate(26deg)',
          opacity: 0.98,
        }}
      />
      <div
        className="absolute right-[-8%] top-[-6%] h-[40vw] w-[28vw] min-h-[340px] min-w-[220px] rounded-[40%]"
        style={{
          background: 'linear-gradient(180deg, rgba(173, 112, 255, 0.74) 0%, rgba(49, 92, 255, 0.10) 84%, rgba(255,255,255,0) 100%)',
          filter: 'blur(12px)',
          transform: 'rotate(18deg)',
        }}
      />
      <div
        className="absolute left-[36%] top-[30%] h-[24vw] w-[22vw] min-h-[220px] min-w-[180px] rounded-[46%]"
        style={{
          background: 'linear-gradient(180deg, rgba(255, 235, 255, 0.64) 0%, rgba(141, 121, 255, 0.18) 100%)',
          filter: 'blur(10px)',
          transform: 'rotate(-18deg)',
          opacity: 0.84,
        }}
      />
      <div
        className="absolute left-[-12%] bottom-[-12%] h-[44vw] w-[40vw] min-h-[360px] min-w-[280px] rounded-[44%]"
        style={{
          background: 'linear-gradient(180deg, rgba(52, 79, 255, 0.52) 0%, rgba(12, 18, 84, 0.12) 80%, rgba(255,255,255,0) 100%)',
          filter: 'blur(20px)',
          transform: 'rotate(-24deg)',
        }}
      />
      <div
        className="absolute right-[-10%] bottom-[-10%] h-[34vw] w-[24vw] min-h-[280px] min-w-[190px] rounded-[44%]"
        style={{
          background: 'linear-gradient(180deg, rgba(24, 44, 156, 0.94) 0%, rgba(4, 6, 28, 0.02) 92%)',
          filter: 'blur(8px)',
          transform: 'rotate(24deg)',
        }}
      />
    </div>
  )
}

const primitiveVeilStyle: Record<LiquidGlassTone, CSSProperties> = {
  button: {
    background: 'rgba(255,255,255,0.012)',
    opacity: 1,
  },
  card: {
    background: 'rgba(255,255,255,0.018)',
    opacity: 1,
  },
  panel: {
    background: 'rgba(255,255,255,0.01)',
    opacity: 1,
  },
}

const primitiveNoiseStyle: CSSProperties = {
  backgroundImage: `url("${NOISE_TEXTURE}")`,
  backgroundSize: '180px 180px',
  backgroundRepeat: 'repeat',
  opacity: 0.018,
  mixBlendMode: 'soft-light',
}

export function LiquidGlassPrimitive({
  id,
  tone,
  mouseContainer,
  className,
  style,
  innerClassName,
  innerStyle,
  radius,
  children,
}: LiquidGlassPrimitiveProps) {
  const sceneContainer = useLiquidSceneContainer()
  const resolvedContainer = mouseContainer ?? sceneContainer
  const config = {
    ...primitiveByTone[tone],
    cornerRadius: radius ?? primitiveByTone[tone].cornerRadius,
  }

  return (
    <div data-glass-primitive={id} className={className} style={style}>
      <LiquidGlass
        {...config}
        mouseContainer={resolvedContainer}
        className="block w-full"
        style={{ width: '100%' }}
      >
        <div
          className={`relative isolate overflow-hidden ${innerClassName ?? ''}`}
          style={{
            borderRadius: config.cornerRadius,
            textShadow: LIQUID_TEXT_SHADOW,
            color: 'inherit',
            background: 'transparent',
            ...innerStyle,
          }}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={primitiveVeilStyle[tone]}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={primitiveNoiseStyle}
          />
          <div className="relative z-10">{children}</div>
        </div>
      </LiquidGlass>
    </div>
  )
}
