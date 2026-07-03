/**
 * P0-4 (2026-07-02 P0 visibility batch) — run quality dashboard: proof_gap
 * daily share, adjudication divergence, first-token latency, and stream
 * fallback counters, aggregated main-side from the agent metrics log.
 * Numbers-first, zero decoration（workbench 极简基准）。
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { RunQualityStatsData } from '../../types/electron'
import { SETTINGS_CARD_STYLE, SETTINGS_FLAT_BUTTON_STYLE } from '../settings/settings-theme'

function percentLabel(part: number, total: number): string {
  if (total <= 0) return '—'
  return `${Math.round((part / total) * 100)}%`
}

function msLabel(value: number | null): string {
  if (value == null) return '—'
  if (value < 1000) return `${value}ms`
  return `${(value / 1000).toFixed(1)}s`
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 84 }}>
      <span className="t-meta" data-typography-role="meta" style={{ color: 'var(--text-gray)' }}>{label}</span>
      <span className="t-data" data-typography-role="data" style={{ color: 'var(--text-body)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

export function RunQualityPanel() {
  const [stats, setStats] = useState<RunQualityStatsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.runQuality?.stats) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.runQuality.stats()
      if (result?.success && result.data) setStats(result.data)
      else setError(result?.error || '读取运行质量数据失败')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const totals = (stats?.days || []).reduce(
    (acc, day) => ({
      total: acc.total + day.total,
      proofGap: acc.proofGap + day.proofGap,
      degraded: acc.degraded + day.degraded,
      unconfirmed: acc.unconfirmed + day.unconfirmed,
    }),
    { total: 0, proofGap: 0, degraded: 0, unconfirmed: 0 },
  )
  const recentDays = (stats?.days || []).slice(-7)
  const fallbackEntries: Array<[string, number]> = Object.entries(stats?.streamFallbacks ?? {})

  return (
    <div className="glass-surface-card border" data-run-quality-panel="true" style={{ ...SETTINGS_CARD_STYLE, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="flex items-center justify-between gap-2">
        <div className="t-ui" data-typography-role="ui" style={{ color: 'var(--text-body)' }}>
          运行质量（最近 {stats?.windowDays ?? 14} 天）
        </div>
        <button
          type="button"
          onClick={() => { void refresh() }}
          disabled={loading}
          style={{ ...SETTINGS_FLAT_BUTTON_STYLE, display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <RefreshCw style={{ width: 12, height: 12 }} />
          {loading ? '读取中' : '刷新'}
        </button>
      </div>
      {error ? (
        <div className="t-meta" data-typography-role="meta" style={{ color: 'var(--color-red)' }}>{error}</div>
      ) : null}
      <div className="flex flex-wrap" style={{ gap: 16 }} data-run-quality-summary="true">
        <StatCell label="运行样本" value={String(stats?.sampleSize ?? 0)} />
        <StatCell label="proof_gap 占比" value={percentLabel(totals.proofGap, totals.total)} />
        <StatCell label="判定降级占比" value={percentLabel(totals.degraded, totals.total)} />
        <StatCell label="裁决分歧" value={String(stats?.divergenceCount ?? 0)} />
        <StatCell label="首 token p50" value={msLabel(stats?.firstDelta.p50Ms ?? null)} />
        <StatCell label="流式降级" value={String(fallbackEntries.reduce((sum, [, count]) => sum + count, 0))} />
      </div>
      {recentDays.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-run-quality-days="true">
          {recentDays.map((day) => (
            <div key={day.date} className="flex items-center t-meta" data-typography-role="meta" style={{ gap: 10, color: 'var(--text-gray)' }}>
              <span style={{ width: 78, flexShrink: 0 }}>{day.date.slice(5)}</span>
              <span style={{ width: 64, fontVariantNumeric: 'tabular-nums' }}>{day.total} runs</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', color: day.proofGap > 0 ? 'var(--color-red)' : 'var(--text-gray)' }}>
                proof_gap {day.proofGap}（{percentLabel(day.proofGap, day.total)}）
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="t-meta" data-typography-role="meta" style={{ color: 'var(--text-gray)' }}>
          窗口内暂无运行记录。
        </div>
      )}
      {fallbackEntries.length > 0 ? (
        <div className="t-meta" data-typography-role="meta" style={{ color: 'var(--text-gray)' }}>
          流式降级明细：{fallbackEntries.map(([reason, count]) => `${reason}×${count}`).join('、')}
        </div>
      ) : null}
    </div>
  )
}
