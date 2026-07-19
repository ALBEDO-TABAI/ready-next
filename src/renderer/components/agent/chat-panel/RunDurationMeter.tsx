import { useEffect, useMemo, useState } from 'react'
import type { ScopeRunState } from '../../../stores/useAgent'
import { DotGlyph } from '../../ui/dot-matrix/DotGlyph'
import type { DotGlyphName, DotGlyphTone } from '../../ui/dot-matrix/dot-glyphs'

const LIVE_PHASES: ReadonlySet<ScopeRunState['phase']> = new Set([
  'queued',
  'planning',
  'tool_running',
  'takeover',
  'resuming',
  'responding',
])

export interface RunDurationMeterModel {
  label: string
  duration: string
  glyph: DotGlyphName
  tone: DotGlyphTone
  pulse: boolean
  live: boolean
}

function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function formatRunDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  const pad = (value: number) => String(value).padStart(2, '0')

  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`
  return `${pad(minutes)}:${pad(seconds)}`
}

function runDurationLabel(run: ScopeRunState): Pick<RunDurationMeterModel, 'label' | 'glyph' | 'tone'> {
  if (LIVE_PHASES.has(run.phase)) {
    // P0-3 — planning-stage heartbeats ("正在理解需求…/正在调用模型…") surface
    // here instead of the static label, so the pre-first-output window shows
    // real progression. Raw status echoes ("状态：working") and long texts
    // stay on the generic label.
    const trimmed = run.phase === 'planning' && typeof run.latestText === 'string'
      ? run.latestText.trim()
      : ''
    const heartbeat = trimmed && !trimmed.startsWith('状态：') && trimmed.length <= 30 ? trimmed : null
    return { label: heartbeat || '本轮进行中', glyph: 'running', tone: 'neutral' }
  }
  if (run.phase === 'cancelled') {
    return { label: '本轮已停止', glyph: 'idle', tone: 'neutral' }
  }
  if (run.phase === 'error') {
    return { label: '本轮失败', glyph: 'error', tone: 'signal' }
  }
  if (run.phase === 'checkpoint') {
    const hasWaitingTarget = Boolean(
      run.taskContinuation
      || (run.waitingFor && run.waitingFor !== 'none')
      || (run.resumableActions && run.resumableActions.length > 0),
    )
    return hasWaitingTarget
      ? { label: '本轮等待中', glyph: 'needs_input', tone: 'signal' }
      : { label: '本轮未完成', glyph: 'error', tone: 'signal' }
  }
  return { label: '本轮用时', glyph: 'done', tone: 'neutral' }
}

export function buildRunDurationMeterModel(
  run: ScopeRunState | null | undefined,
  nowMs: number,
): RunDurationMeterModel | null {
  const startedAt = timestampMs(run?.startedAt)
  if (!run || run.phase === 'idle' || startedAt == null) return null

  const live = LIVE_PHASES.has(run.phase)
  const endedAt = live ? nowMs : timestampMs(run.updatedAt) ?? nowMs
  const label = runDurationLabel(run)

  return {
    ...label,
    duration: formatRunDuration(endedAt - startedAt),
    pulse: live,
    live,
  }
}

export function RunDurationMeter({
  run,
}: {
  run: ScopeRunState | null
}): React.ReactElement | null {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const model = useMemo(() => buildRunDurationMeterModel(run, nowMs), [run, nowMs])

  useEffect(() => {
    if (!model?.live) return
    const update = () => setNowMs(Date.now())
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [model?.live, run?.requestId, run?.startedAt])

  if (!model) return null

  return (
    <div className="flex" style={{ padding: '0 6px 2px' }}>
      <div
        data-agent-run-duration-meter="true"
        aria-label={`${model.label} ${model.duration}`}
        className="t-meta"
        data-typography-role="meta"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          minHeight: 24,
          padding: '5px 8px',
          color: 'var(--text-light)',
        }}
      >
        <DotGlyph
          name={model.glyph}
          tone={model.tone}
          pulse={model.pulse}
          size={13}
          title={model.label}
          style={{ color: model.tone === 'signal' ? undefined : 'var(--text-gray)' }}
        />
        <span style={{ whiteSpace: 'nowrap' }}>{model.label}</span>
        <span
          className="t-data"
          data-typography-role="data"
          style={{
            color: 'var(--text-body)',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {model.duration}
        </span>
      </div>
    </div>
  )
}
