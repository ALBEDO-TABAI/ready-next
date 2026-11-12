import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { createReadyLogoDotPattern } from '../../../shared/ready-logo-dots'
import readyWordmarkSvg from '../../assets/ready-wordmark.svg?raw'
import '../../styles/startup-preview.css'

const GRID_ROWS = 8
const GRID_COLUMNS = 37
const MATRIX_ROW_STEP = 137
const MATRIX_COLUMN_STEP = 139
const MATRIX_DOT_RADIUS = 52
const MATRIX_X_START = 75
const MATRIX_Y_START = 75
const LOGO_X_OFFSET = MATRIX_COLUMN_STEP * 4
const LOGO_Y_OFFSET = MATRIX_ROW_STEP
const MATRIX_WIDTH = 5160
const MATRIX_HEIGHT = 1109
const READY_LOGO_PATTERN = createReadyLogoDotPattern(readyWordmarkSvg, {
  xOffset: LOGO_X_OFFSET,
  yOffset: LOGO_Y_OFFSET,
  matrixXStart: MATRIX_X_START,
  matrixColumnStep: MATRIX_COLUMN_STEP,
})
const BACKDROP_REVEAL_MS = 680
const LOGO_COLUMN_MS = 86
const SIMULATED_READY_MS = 5200
const LOGO_COMPLETE_MS = 980
const BACKDROP_FADE_DELAY_MS = 240
const BACKDROP_FADE_MS = 560
const FINAL_LOGO_HOLD_MS = 460
const CARD_EXIT_MS = 280
const RESTART_PAUSE_MS = 850
const EXIT_TOTAL_MS = LOGO_COMPLETE_MS + FINAL_LOGO_HOLD_MS + CARD_EXIT_MS
const DEMO_LOOP_MS = SIMULATED_READY_MS + EXIT_TOTAL_MS + RESTART_PAUSE_MS

// The brand mark in the one signal colour (--rn-accent). This React splash (the preview page and the
// splash window's route) mounts after main.tsx has loaded styles/index.css, so the tokens are there;
// the boot-time inline splash (src/main/startup-splash-html.ts) paints before any stylesheet and keeps
// its own colours.
const SPLASH_COLORS = {
  logo: 'var(--rn-accent)',
  glow: 'color-mix(in srgb, var(--rn-accent) 18%, transparent)'
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

function resolveFinishBackdropOpacity(finishElapsedMs: number | null): number {
  if (finishElapsedMs === null) return 1
  const fadeElapsedMs = Math.max(0, finishElapsedMs - BACKDROP_FADE_DELAY_MS)
  return 1 - easeInOutCubic(fadeElapsedMs / BACKDROP_FADE_MS)
}

function resolveCardOpacity(finishElapsedMs: number | null): number {
  if (finishElapsedMs === null) return 1
  const exitElapsedMs = finishElapsedMs - LOGO_COMPLETE_MS - FINAL_LOGO_HOLD_MS
  if (exitElapsedMs <= 0) return 1
  return 1 - easeInOutCubic(exitElapsedMs / CARD_EXIT_MS)
}

function resolveLogoDotOpacity(
  columnIndex: number,
  loopElapsedMs: number,
  finishElapsedMs: number | null,
): number {
  if (finishElapsedMs !== null) {
    const buildProgress = easeOutCubic(finishElapsedMs / LOGO_COMPLETE_MS) * READY_LOGO_PATTERN.columnCount
    return 0.96 * clamp01(buildProgress - columnIndex)
  }

  const activeColumnIndex = Math.floor(loopElapsedMs / LOGO_COLUMN_MS) % READY_LOGO_PATTERN.columnCount
  if (columnIndex !== activeColumnIndex) return 0
  const phase = (loopElapsedMs % LOGO_COLUMN_MS) / LOGO_COLUMN_MS
  return 0.78 + 0.18 * Math.sin(phase * Math.PI)
}

interface ReadyStartupSplashProps {
  ready?: boolean
  demo?: boolean
  overlay?: boolean
  onExitComplete?: () => void
}

export default function ReadyStartupSplash({
  ready = false,
  demo = false,
  overlay = false,
  onExitComplete
}: ReadyStartupSplashProps) {
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
  const colors = SPLASH_COLORS

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
          aria-hidden="true"
        >
          <svg viewBox={`0 0 ${MATRIX_WIDTH} ${MATRIX_HEIGHT}`} preserveAspectRatio="xMidYMid meet" style={{ color: colors.logo }}>
            {READY_LOGO_PATTERN.dots.map((dot, index) => (
              <circle
                key={`${dot.x}-${dot.y}-${index}`}
                cx={dot.x}
                cy={dot.y}
                r={dot.r}
                fill="currentColor"
                opacity={resolveLogoDotOpacity(dot.columnIndex, loopElapsedMs, finishElapsedMs)}
              />
            ))}
          </svg>
        </div>
      </section>
    </main>
  )
}
