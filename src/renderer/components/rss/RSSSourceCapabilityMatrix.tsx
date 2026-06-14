import { ExternalLink, Gauge, RefreshCw } from 'lucide-react'
import type {
  RSSBenchmarkResultData,
  RSSDiagnosticsData,
  RSSSourceDiagnosticsEntry,
  SourceBackend,
  SourceBackendState,
} from '../../modules/rss/types'
import { WORKBENCH_ROW_PADDING_X } from '../../modules/workbench/chrome'

interface RSSSourceCapabilityMatrixProps {
  diagnostics: RSSDiagnosticsData | null
  benchmark: RSSBenchmarkResultData | null
  benchmarking: boolean
  onBenchmark: () => void | Promise<void>
}

function formatDuration(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未记录'
  if (value < 1000) return `${value}ms`
  return `${(value / 1000).toFixed(1)}s`
}

function backendLabel(backend: SourceBackend): string {
  if (backend === 'native') return 'Native'
  if (backend === 'rsshub') return 'RSSHub'
  if (backend === 'browser') return 'Browser'
  return 'Scrapling'
}

function stateLabel(state: SourceBackendState): string {
  if (state === 'stable') return '稳定'
  if (state === 'conditional') return '条件稳定'
  if (state === 'failing') return '失败'
  return '未测试'
}

function stateTone(state: SourceBackendState): { color: string; background: string; border: string } {
  if (state === 'stable') {
    return {
      color: 'var(--color-green)',
      background: 'rgba(240,253,244,0.76)',
      border: 'rgba(34,197,94,0.24)',
    }
  }
  if (state === 'conditional') {
    return {
      color: 'var(--color-orange)',
      background: 'rgba(255,251,235,0.82)',
      border: 'rgba(245,158,11,0.24)',
    }
  }
  if (state === 'failing') {
    return {
      color: 'var(--color-red)',
      background: 'rgba(254,242,242,0.84)',
      border: 'rgba(239,68,68,0.2)',
    }
  }
  return {
    color: 'var(--text-light)',
    background: 'rgba(248,250,252,0.82)',
    border: 'var(--border-default)',
  }
}

function failureSummary(entry: RSSSourceDiagnosticsEntry): string {
  if (entry.lastRouteError) {
    return `${entry.lastRouteError.kind}${entry.lastRouteError.detail ? ` · ${entry.lastRouteError.detail}` : ''}`
  }
  if (entry.lastWarning) return `warning · ${entry.lastWarning}`
  return '无'
}

function browserActionLabel(entry: RSSSourceDiagnosticsEntry): string {
  const kind = entry.lastRouteError?.kind
  if (kind === 'auth') return '在 Ready 浏览器中登录'
  if (kind === 'anti_bot' || kind === 'waf') return '在 Ready 浏览器中继续验证'
  return '在 Ready 浏览器中查看'
}

export default function RSSSourceCapabilityMatrix({
  diagnostics,
  benchmark,
  benchmarking,
  onBenchmark,
}: RSSSourceCapabilityMatrixProps) {
  if (!diagnostics) return null

  const sources = diagnostics.sources || []
  const stableCount = sources.filter((entry) => entry.backendState === 'stable').length
  const failingCount = sources.filter((entry) => entry.backendState === 'failing').length
  const candidateCount = sources.filter((entry) => entry.scraplingEligible).length

  return (
    <div
      className="border-b py-3"
      style={{
        borderColor: 'var(--border-default)',
        background: 'rgba(255,255,255,0.82)',
        paddingLeft: WORKBENCH_ROW_PADDING_X,
        paddingRight: WORKBENCH_ROW_PADDING_X,
      }}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--text-light)' }}>
            RSS Source Matrix
          </div>
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
            按源查看 backend、失败分类和 Scrapling 候选
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-light)' }}>
            微博、抖音、小红书已按浏览器主链展示；Scrapling 只在候选平台做 benchmark。
          </div>
        </div>

        <button
          onClick={() => void onBenchmark()}
          className="inline-flex items-center gap-2 rounded-[8px] border px-3 py-2 text-[11px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            borderColor: 'var(--border-default)',
            color: 'var(--text-title)',
            background: 'rgba(255,255,255,0.78)',
          }}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${benchmarking ? 'animate-spin' : ''}`} />
          运行基准
        </button>
      </div>

      <div className="mb-3 grid gap-2 text-[11px] md:grid-cols-4">
        <div className="rounded-[12px] border px-3 py-2" style={{ borderColor: 'var(--border-default)' }}>
          <div style={{ color: 'var(--text-light)' }}>总源数</div>
          <div className="mt-1 font-medium" style={{ color: 'var(--text-title)' }}>{sources.length}</div>
        </div>
        <div className="rounded-[12px] border px-3 py-2" style={{ borderColor: 'rgba(34,197,94,0.24)' }}>
          <div style={{ color: 'var(--text-light)' }}>稳定</div>
          <div className="mt-1 font-medium" style={{ color: 'var(--text-title)' }}>{stableCount}</div>
        </div>
        <div className="rounded-[12px] border px-3 py-2" style={{ borderColor: 'rgba(239,68,68,0.2)' }}>
          <div style={{ color: 'var(--text-light)' }}>失败</div>
          <div className="mt-1 font-medium" style={{ color: 'var(--text-title)' }}>{failingCount}</div>
        </div>
        <div className="rounded-[12px] border px-3 py-2" style={{ borderColor: 'rgba(245,158,11,0.24)' }}>
          <div style={{ color: 'var(--text-light)' }}>Scrapling 候选</div>
          <div className="mt-1 font-medium" style={{ color: 'var(--text-title)' }}>{candidateCount}</div>
        </div>
      </div>

      {benchmark ? (
        <div
          className="mb-3 flex items-center gap-2 rounded-[12px] border px-3 py-2 text-[11px]"
          style={{
            borderColor: 'rgba(59,130,246,0.2)',
            background: 'rgba(239,246,255,0.72)',
            color: 'var(--text-secondary)',
          }}
        >
          <Gauge className="h-3.5 w-3.5" style={{ color: 'var(--color-blue)' }} />
          最近基准：{benchmark.summary.successCount}/{benchmark.summary.sourceCount} 成功 · p50 {formatDuration(benchmark.summary.p50DurationMs)} · p95 {formatDuration(benchmark.summary.p95DurationMs)}
          {benchmark.summary.scraplingCandidatePlatforms.length > 0
            ? ` · 候选平台 ${benchmark.summary.scraplingCandidatePlatforms.join(', ')}`
            : ' · 暂无 Scrapling 候选通过门槛'}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-[11px]">
          <thead style={{ color: 'var(--text-light)' }}>
            <tr>
              <th className="px-2 py-2 font-medium">源</th>
              <th className="px-2 py-2 font-medium">平台</th>
              <th className="px-2 py-2 font-medium">Backend</th>
              <th className="px-2 py-2 font-medium">状态</th>
              <th className="px-2 py-2 font-medium">Chromium</th>
              <th className="px-2 py-2 font-medium">最近失败</th>
              <th className="px-2 py-2 font-medium">Fallback</th>
              <th className="px-2 py-2 font-medium">耗时</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((entry) => {
              const tone = stateTone(entry.backendState)
              return (
                <tr key={entry.sourceId} className="border-t" style={{ borderColor: 'var(--border-default)' }}>
                  <td className="px-2 py-2 align-top">
                    <div className="font-medium" style={{ color: 'var(--text-title)' }}>{entry.sourceName}</div>
                    <div style={{ color: 'var(--text-light)' }}>{entry.groupName}</div>
                  </td>
                  <td className="px-2 py-2 align-top" style={{ color: 'var(--text-secondary)' }}>
                    {entry.platformLabel}
                  </td>
                  <td className="px-2 py-2 align-top" style={{ color: 'var(--text-secondary)' }}>
                    {backendLabel(entry.backend)}
                  </td>
                  <td className="px-2 py-2 align-top">
                    <span
                      className="inline-flex rounded-full px-2 py-1 text-[10px] font-medium"
                      style={{
                        color: tone.color,
                        background: tone.background,
                        border: `1px solid ${tone.border}`,
                      }}
                    >
                      {stateLabel(entry.backendState)}
                    </span>
                  </td>
                  <td className="px-2 py-2 align-top" style={{ color: 'var(--text-secondary)' }}>
                    {entry.chromiumRequired ? '需要' : '不需要'}
                  </td>
                  <td className="max-w-[240px] px-2 py-2 align-top" style={{ color: 'var(--text-secondary)' }}>
                    <div>{failureSummary(entry)}</div>
                    {entry.lastRouteError?.message ? (
                      <div className="truncate" style={{ color: 'var(--text-light)' }} title={entry.lastRouteError.message}>
                        {entry.lastRouteError.message}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 align-top" style={{ color: 'var(--text-secondary)' }}>
                    <div>{entry.fallbackOrder.join(' -> ')}</div>
                    <div style={{ color: 'var(--text-light)' }}>
                      {entry.scraplingEligible ? '可评估 Scrapling' : '保持当前链路'}
                    </div>
                    {entry.backend === 'browser' && entry.lastRouteError ? (
                      <button
                        onClick={() => void window.electronAPI?.browser?.openForCaptureTarget(entry.url)}
                        className="mt-2 inline-flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[10px] transition-colors hover:bg-[var(--bg-hover)]"
                        style={{
                          borderColor: 'var(--border-default)',
                          color: 'var(--text-title)',
                          background: 'rgba(255,255,255,0.74)',
                        }}
                      >
                        <ExternalLink className="h-3 w-3" />
                        {browserActionLabel(entry)}
                      </button>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 align-top" style={{ color: 'var(--text-secondary)' }}>
                    {formatDuration(entry.lastDurationMs)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
