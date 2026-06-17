import { type CSSProperties, useEffect, useId, useMemo, useState } from 'react'
import readyWordmark from '../../assets/ready-wordmark.svg'
import '../../styles/startup-preview.css'

export type ReadyStartupVariant = 'orange' | 'pink'

type ReadyStartupSkin = 'liquid-glass' | 'ready-glass' | 'solid-green-glass' | 'solid-blue-glass'

const GRID_ROWS = 8
const GRID_COLUMNS = 37
const LOGO_WIDTH = 4048
const MATRIX_ROW_STEP = 137
const MATRIX_COLUMN_STEP = 139
const MATRIX_DOT_RADIUS = 52
const MATRIX_X_START = 75
const MATRIX_Y_START = 75
const LOGO_X_OFFSET = MATRIX_COLUMN_STEP * 4
const MATRIX_HEIGHT = MATRIX_Y_START * 2 + MATRIX_ROW_STEP * (GRID_ROWS - 1)
const MATRIX_WIDTH = LOGO_WIDTH + LOGO_X_OFFSET * 2
const LOGO_Y_OFFSET = MATRIX_ROW_STEP
const LOGO_HEIGHT = 845
const BACKDROP_REVEAL_MS = 1050
const LOGO_START_DELAY_MS = 520
const LOGO_ON_MS = 1280
const LOGO_HOLD_MS = 780
const LOGO_OFF_MS = 1060
const LOGO_DARK_MS = 340
const LOGO_LOOP_MS = LOGO_ON_MS + LOGO_HOLD_MS + LOGO_OFF_MS + LOGO_DARK_MS
const SIMULATED_READY_MS = 11600
const BACKDROP_FADE_MS = 760
const FINAL_LOGO_HOLD_MS = 2000
const CARD_EXIT_MS = 620
const RESTART_PAUSE_MS = 850
const EXIT_TOTAL_MS = BACKDROP_FADE_MS + FINAL_LOGO_HOLD_MS + CARD_EXIT_MS
const DEMO_LOOP_MS = SIMULATED_READY_MS + EXIT_TOTAL_MS + RESTART_PAUSE_MS

const VARIANT_COLORS: Record<ReadyStartupVariant, { logo: string; glow: string }> = {
  orange: {
    logo: '#FF4B2B',
    glow: 'rgba(255, 75, 43, 0.18)'
  },
  pink: {
    logo: '#F366AD',
    glow: 'rgba(243, 102, 173, 0.22)'
  }
}

export function resolveReadyStartupVariantFromSkin(
  skin: string | null | undefined
): ReadyStartupVariant {
  return skin === 'solid-green-glass' || skin === 'solid-blue-glass' ? 'pink' : 'orange'
}

export function readStoredReadyStartupVariant(): ReadyStartupVariant {
  if (typeof window === 'undefined') return 'orange'
  const stored = window.localStorage.getItem('ready-theme-skin') as ReadyStartupSkin | null
  return resolveReadyStartupVariantFromSkin(stored)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function easeOutCubic(value: number): number {
  const t = clamp01(value)
  return 1 - Math.pow(1 - t, 3)
}

function easeInOutCubic(value: number): number {
  const t = clamp01(value)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function resolveLoopLogoClipPath(elapsedMs: number): string {
  if (elapsedMs < LOGO_START_DELAY_MS) return 'inset(0 100% 0 0)'

  const cycleMs = (elapsedMs - LOGO_START_DELAY_MS) % LOGO_LOOP_MS

  if (cycleMs < LOGO_ON_MS) {
    const progress = easeOutCubic(cycleMs / LOGO_ON_MS)
    return `inset(0 ${(1 - progress) * 100}% 0 0)`
  }

  if (cycleMs < LOGO_ON_MS + LOGO_HOLD_MS) {
    return 'inset(0 0 0 0)'
  }

  if (cycleMs < LOGO_ON_MS + LOGO_HOLD_MS + LOGO_OFF_MS) {
    const progress = easeInOutCubic((cycleMs - LOGO_ON_MS - LOGO_HOLD_MS) / LOGO_OFF_MS)
    return `inset(0 0 0 ${progress * 100}%)`
  }

  return 'inset(0 100% 0 0)'
}

function resolveFinishBackdropOpacity(finishElapsedMs: number | null): number {
  if (finishElapsedMs === null) return 1
  return 1 - easeInOutCubic(finishElapsedMs / BACKDROP_FADE_MS)
}

function resolveCardOpacity(finishElapsedMs: number | null): number {
  if (finishElapsedMs === null) return 1
  const exitElapsedMs = finishElapsedMs - BACKDROP_FADE_MS - FINAL_LOGO_HOLD_MS
  if (exitElapsedMs <= 0) return 1
  return 1 - easeInOutCubic(exitElapsedMs / CARD_EXIT_MS)
}

interface ReadyStartupSplashProps {
  variant?: ReadyStartupVariant
  ready?: boolean
  demo?: boolean
  overlay?: boolean
  onExitComplete?: () => void
}

export default function ReadyStartupSplash({
  variant = 'orange',
  ready = false,
  demo = false,
  overlay = false,
  onExitComplete
}: ReadyStartupSplashProps) {
  const rawMaskId = useId()
  const logoMaskId = useMemo(
    () => `ready-startup-logo-mask-${rawMaskId.replace(/:/g, '')}`,
    [rawMaskId]
  )
  const [nowMs, setNowMs] = useState(() => performance.now())
  const [startedAtMs] = useState(() => performance.now())
  const [finishStartedAtMs, setFinishStartedAtMs] = useState<number | null>(null)
  const [isHidden, setIsHidden] = useState(false)
  const dots = useMemo(
    () =>
      Array.from({ length: GRID_ROWS * GRID_COLUMNS }, (_, index) => ({
        row: Math.floor(index / GRID_COLUMNS),
        column: index % GRID_COLUMNS,
        x: MATRIX_X_START + (index % GRID_COLUMNS) * MATRIX_COLUMN_STEP,
        y: MATRIX_Y_START + Math.floor(index / GRID_COLUMNS) * MATRIX_ROW_STEP
      })),
    []
  )

  useEffect(() => {
    if (!ready || demo || finishStartedAtMs !== null) return
    setFinishStartedAtMs(performance.now())
  }, [demo, finishStartedAtMs, ready])

  useEffect(() => {
    if (isHidden) return
    let frameId = 0

    const tick = (now: number): void => {
      setNowMs(now)
      frameId = window.requestAnimationFrame(tick)
    }

    frameId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameId)
  }, [isHidden])

  useEffect(() => {
    if (demo || finishStartedAtMs === null || isHidden) return
    if (nowMs - finishStartedAtMs < EXIT_TOTAL_MS) return
    setIsHidden(true)
    onExitComplete?.()
  }, [demo, finishStartedAtMs, isHidden, nowMs, onExitComplete])

  if (isHidden) return null

  const demoElapsedMs = (nowMs - startedAtMs) % DEMO_LOOP_MS
  const isDemoFinishing =
    demoElapsedMs >= SIMULATED_READY_MS && demoElapsedMs < SIMULATED_READY_MS + EXIT_TOTAL_MS
  const loopElapsedMs = demo ? Math.min(demoElapsedMs, SIMULATED_READY_MS) : nowMs - startedAtMs
  const finishElapsedMs = demo
    ? isDemoFinishing
      ? demoElapsedMs - SIMULATED_READY_MS
      : null
    : finishStartedAtMs === null
      ? null
      : nowMs - finishStartedAtMs
  const visibleColumns =
    loopElapsedMs < BACKDROP_REVEAL_MS
      ? easeOutCubic(loopElapsedMs / BACKDROP_REVEAL_MS) * GRID_COLUMNS
      : GRID_COLUMNS
  const backdropOpacity = resolveFinishBackdropOpacity(finishElapsedMs)
  const cardOpacity = resolveCardOpacity(finishElapsedMs)
  const logoClipPath =
    finishElapsedMs === null ? resolveLoopLogoClipPath(loopElapsedMs) : 'inset(0 0 0 0)'
  const colors = VARIANT_COLORS[variant]

  return (
    <main
      className={`startup-preview${overlay ? ' startup-preview--overlay' : ''}`}
      aria-label="Ready startup animation"
      style={{ '--ready-startup-logo-glow': colors.glow } as CSSProperties}
    >
      <section
        className="startup-preview__card"
        style={{ opacity: cardOpacity }}
        aria-label="Ready loading mark"
      >
        <div className="startup-preview__matrix" aria-hidden="true">
          <svg viewBox={`0 0 ${MATRIX_WIDTH} ${MATRIX_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
            {dots.map((dot) => {
              const dotOpacity = backdropOpacity * 0.34 * clamp01(visibleColumns - dot.column)
              return (
                <circle
                  key={`${dot.row}-${dot.column}`}
                  cx={dot.x}
                  cy={dot.y}
                  r={MATRIX_DOT_RADIUS}
                  fill="currentColor"
                  opacity={dotOpacity}
                />
              )
            })}
          </svg>
        </div>
        <div
          className="startup-preview__matrix startup-preview__matrix--logo"
          style={{ clipPath: logoClipPath }}
          aria-hidden="true"
        >
          <svg viewBox={`0 0 ${MATRIX_WIDTH} ${MATRIX_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
            <defs>
              <mask
                id={logoMaskId}
                maskUnits="userSpaceOnUse"
                x={LOGO_X_OFFSET}
                y={LOGO_Y_OFFSET}
                width={LOGO_WIDTH}
                height={LOGO_HEIGHT}
              >
                <image
                  href={readyWordmark}
                  x={LOGO_X_OFFSET}
                  y={LOGO_Y_OFFSET}
                  width={LOGO_WIDTH}
                  height={LOGO_HEIGHT}
                />
              </mask>
            </defs>
            <rect
              x={LOGO_X_OFFSET}
              y={LOGO_Y_OFFSET}
              width={LOGO_WIDTH}
              height={LOGO_HEIGHT}
              fill={colors.logo}
              mask={`url(#${logoMaskId})`}
            />
          </svg>
        </div>
      </section>
    </main>
  )
}
