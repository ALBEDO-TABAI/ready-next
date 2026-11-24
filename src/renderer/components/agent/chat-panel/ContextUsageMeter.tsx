import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ContextUsageSnapshot } from '../../../../shared/context-usage-types'
import { LeavingDiv } from '../../ui/Leaving'

export interface ContextUsageMeterModel {
  ariaLabel: string
  title: string
  tooltipLines: string[]
  ratio: number | null
  tone: 'unknown' | 'ok' | 'soft' | 'hard'
  dimmed: boolean
}

function formatCompactTokenCount(value: number): string {
  const tokens = Math.max(0, Math.round(value))
  if (tokens >= 1_000_000) {
    const compact = tokens / 1_000_000
    return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1).replace(/\.0$/, '')}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

function formatExactTokenCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US')
}

export function buildContextUsageMeterModel(
  usage: ContextUsageSnapshot | null | undefined,
  dimmed: boolean,
): ContextUsageMeterModel {
  const noDataLines = ['上下文视窗', '暂无数据', '发送一轮后显示']
  if (!usage) {
    return {
      ariaLabel: '上下文视窗暂无数据',
      title: noDataLines.join('\n'),
      tooltipLines: noDataLines,
      ratio: null,
      tone: 'unknown',
      dimmed,
    }
  }

  if (usage.ratio == null || !usage.windowTokens) {
    const lines = [
      '上下文视窗',
      `${formatExactTokenCount(usage.usedInputTokens)} tokens`,
      '窗口大小未知 · 上一轮实际请求',
    ]
    return {
      ariaLabel: `上下文视窗窗口大小未知，已使用 ${formatCompactTokenCount(usage.usedInputTokens)} tokens`,
      title: lines.join('\n'),
      tooltipLines: lines,
      ratio: null,
      tone: 'unknown',
      dimmed,
    }
  }

  const percent = Math.max(0, Math.round(usage.ratio * 100))
  const tone = usage.ratio >= 0.95 ? 'hard' : usage.ratio >= 0.8 ? 'soft' : 'ok'
  const estimated = usage.windowSource === 'fallback'
  const lines = [
    '上下文视窗',
    `${formatExactTokenCount(usage.usedInputTokens)} / ${formatExactTokenCount(usage.windowTokens)} tokens`,
    estimated ? `约 ${percent}% · 默认估算 · 上一轮实际请求` : `${percent}% 满 · 上一轮实际请求`,
  ]
  return {
    ariaLabel: estimated
      ? `上下文视窗约 ${percent}%，按默认窗口估算，已使用 ${formatCompactTokenCount(usage.usedInputTokens)} / ${formatCompactTokenCount(usage.windowTokens)} tokens`
      : `上下文视窗 ${percent}% 满，已使用 ${formatCompactTokenCount(usage.usedInputTokens)} / ${formatCompactTokenCount(usage.windowTokens)} tokens`,
    title: lines.join('\n'),
    tooltipLines: lines,
    ratio: usage.ratio,
    tone,
    dimmed,
  }
}

// The meter sits in the composer, so its greys are the composer's inks (--rn-liquid-*); the tooltip is a float.
function strokeForTone(tone: ContextUsageMeterModel['tone']): string {
  if (tone === 'hard') return 'var(--rn-bad)'
  if (tone === 'soft') return 'var(--rn-warn)'
  if (tone === 'ok') return 'var(--rn-liquid-ink-2)'
  return 'color-mix(in srgb, var(--rn-liquid-ink-3) 72%, transparent)'
}

export function ContextUsageMeter({
  usage,
  dimmed = false,
}: {
  usage: ContextUsageSnapshot | null | undefined
  dimmed?: boolean
}): React.ReactElement {
  const model = buildContextUsageMeterModel(usage, dimmed)
  const meterRef = useRef<HTMLDivElement | null>(null)
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null)
  const radius = 6.5
  const circumference = 2 * Math.PI * radius
  const clampedRatio = model.ratio == null ? null : Math.max(0, Math.min(model.ratio, 1))
  // With no reading yet only the track shows: a partial arc beside the send button reads as a spinner, i.e. as a
  // turn still running, which is exactly wrong after a turn that failed before the model answered.
  const dash = `${circumference * (clampedRatio ?? 0)} ${circumference}`
  const stroke = strokeForTone(model.tone)
  const showTooltip = useCallback(() => {
    if (typeof window === 'undefined') return
    const rect = meterRef.current?.getBoundingClientRect()
    if (!rect) return
    const tooltipHalfWidth = 140
    setTooltipPosition({
      left: Math.min(window.innerWidth - tooltipHalfWidth, Math.max(tooltipHalfWidth, rect.left + rect.width / 2)),
      top: Math.max(12, rect.top - 8),
    })
  }, [])
  const hideTooltip = useCallback(() => setTooltipPosition(null), [])
  const tooltip = tooltipPosition && typeof document !== 'undefined'
    ? createPortal(
      <LeavingDiv
        data-ready-native-overlay=""
        data-float-motion="fade"
        data-agent-context-usage-tooltip="true"
        role="tooltip"
        className="rn-float"
        style={{
          position: 'fixed',
          left: tooltipPosition.left,
          top: tooltipPosition.top,
          transform: 'translate(-50%, -100%)',
          zIndex: 10000,
          minWidth: 250,
          maxWidth: 280,
          padding: '9px 12px 10px',
          borderRadius: 8,
          color: 'var(--rn-ink)',
          pointerEvents: 'none',
          whiteSpace: 'normal',
        }}
      >
        {model.tooltipLines.map((line, index) => (
          <div
            key={`${index}:${line}`}
            className={index === 1 ? 't-data' : 't-meta'}
            data-typography-role={index === 1 ? 'data' : 'meta'}
            style={{
              color: index === 0 ? 'var(--rn-ink)' : index === 1 ? 'var(--rn-ink)' : 'var(--rn-ink-3)',
              fontSize: index === 1 ? 14 : 11,
              fontWeight: index === 0 ? 650 : index === 1 ? 650 : 500,
              lineHeight: index === 1 ? 1.25 : 1.3,
              fontVariantNumeric: index === 1 ? 'tabular-nums' : undefined,
              letterSpacing: 0,
              whiteSpace: index === 1 ? 'nowrap' : 'normal',
              marginTop: index === 0 ? 0 : index === 1 ? 5 : 6,
            }}
          >
            {line}
          </div>
        ))}
      </LeavingDiv>,
      document.body,
    )
    : null

  return (
    <>
      <div
        ref={meterRef}
        data-agent-context-usage-meter="true"
        aria-label={model.ariaLabel}
        title={model.title}
        role="img"
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          opacity: model.dimmed ? 0.58 : 1,
          transition: 'opacity var(--rn-d-1) var(--rn-ease-std), background-color var(--rn-d-1) var(--rn-ease-std)',
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          aria-hidden="true"
          style={{ display: 'block' }}
        >
          <circle
            cx="9"
            cy="9"
            r={radius}
            fill="none"
            stroke="color-mix(in srgb, var(--rn-hair-2) 66%, transparent)"
            strokeWidth="2.4"
          />
          <circle
            cx="9"
            cy="9"
            r={radius}
            fill="none"
            stroke={stroke}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray={dash}
            transform="rotate(-90 9 9)"
            // The arc grows and changes colour as the context fills, never jumps (motion language M2).
            style={{ transition: 'stroke-dasharray var(--rn-d-3) var(--rn-ease-std), stroke var(--rn-d-3) var(--rn-ease-std)' }}
          />
        </svg>
      </div>
      {tooltip}
    </>
  )
}
