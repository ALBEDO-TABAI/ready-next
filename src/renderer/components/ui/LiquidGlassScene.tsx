import {
  createContext,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useContext,
} from 'react'

const LiquidSceneContext = createContext<RefObject<HTMLDivElement | null> | null>(null)

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
