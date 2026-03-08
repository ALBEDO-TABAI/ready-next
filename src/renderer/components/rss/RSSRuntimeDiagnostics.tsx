import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldAlert, Sparkles } from 'lucide-react'
import type { RSSDiagnosticsData, RSSHubChromiumSource, RSSStatusData } from '../../modules/rss/types'

interface RSSRuntimeDiagnosticsProps {
  status: RSSStatusData | null
  diagnostics: RSSDiagnosticsData | null
  loading: boolean
  onRefresh: () => void | Promise<void>
  onRepair: () => void | Promise<void>
  repairing: boolean
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return '未记录'
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function chromiumSourceLabel(source: RSSHubChromiumSource): string {
  if (source === 'env') return '环境变量'
  if (source === 'cache') return '缓存 Chromium'
  if (source === 'system') return '系统浏览器'
  if (source === 'downloaded') return '自动下载'
  return '未就绪'
}

function basename(path: string | null | undefined): string {
  if (!path) return '未发现'
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] || path
}

export default function RSSRuntimeDiagnostics({
  status,
  diagnostics,
  loading,
  onRefresh,
  onRepair,
  repairing,
}: RSSRuntimeDiagnosticsProps) {
  if (!status) return null

  const runtime = status.rsshub
  const update = status.update
  const chromium = runtime.chromium
  const rsshubRequired = status.rsshubRequired

  const tone = !rsshubRequired
    ? 'muted'
    : runtime.running && chromium.ready
      ? 'healthy'
      : 'warning'

  const borderColor = tone === 'warning'
    ? 'rgba(245, 158, 11, 0.35)'
    : tone === 'healthy'
      ? 'rgba(34, 197, 94, 0.24)'
      : 'var(--border-default)'

  const accent = tone === 'warning'
    ? 'var(--color-orange)'
    : tone === 'healthy'
      ? 'var(--color-green)'
      : 'var(--text-light)'

  const blockingErrors = Array.from(
    new Set([
      rsshubRequired && !runtime.running ? runtime.lastStartupError || runtime.lastError : null,
      rsshubRequired && !chromium.ready ? chromium.lastError : null,
      ...(update.errors || []),
    ].filter((item): item is string => Boolean(item && item.trim()))),
  ).slice(0, 2)

  const runtimeError = runtime.lastRuntimeError?.trim() || null

  return (
    <div
      className="flex flex-col gap-3 border-b px-5 py-4"
      style={{
        borderColor: 'var(--border-default)',
        background:
          tone === 'warning'
            ? 'linear-gradient(180deg, rgba(255,248,235,0.94) 0%, rgba(255,255,255,0.94) 100%)'
            : 'linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(248,250,252,0.92) 100%)',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]"
              style={{
                background: 'rgba(255,255,255,0.75)',
                color: accent,
                border: `1px solid ${borderColor}`,
              }}
            >
              {runtime.running ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : tone === 'warning' ? (
                <ShieldAlert className="h-3 w-3" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
              RSS Runtime
            </span>
            {diagnostics?.artifacts.hasOpml ? (
              <span className="text-[11px]" style={{ color: 'var(--text-light)' }}>
                OPML 已缓存
              </span>
            ) : null}
          </div>
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
            {!rsshubRequired
              ? '当前订阅未使用 RSSHub'
              : runtime.running
                ? `RSSHub 正在运行 · 127.0.0.1:${runtime.port}`
                : `RSSHub 状态：${runtime.state}`}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-light)' }}>
            Chromium：{chromiumSourceLabel(chromium.source)} · {basename(chromium.executablePath)}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void onRefresh()}
            className="inline-flex items-center gap-2 rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
            style={{
              borderColor,
              color: 'var(--text-title)',
              background: 'rgba(255,255,255,0.75)',
            }}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新状态
          </button>
          <button
            onClick={() => void onRepair()}
            className="inline-flex items-center gap-2 rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
            style={{
              borderColor: 'rgba(245, 158, 11, 0.28)',
              color: 'var(--text-title)',
              background: 'rgba(255,251,235,0.78)',
            }}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${repairing ? 'animate-spin' : ''}`} />
            修复运行时
          </button>
        </div>
      </div>

      <div className="grid gap-2 text-[11px] md:grid-cols-3">
        <div
          className="rounded-[12px] border px-3 py-2"
          style={{ borderColor, background: 'rgba(255,255,255,0.68)' }}
        >
          <div style={{ color: 'var(--text-light)' }}>运行态</div>
          <div className="mt-1 font-medium" style={{ color: 'var(--text-title)' }}>
            {!rsshubRequired ? '当前未启用' : runtime.running ? '服务可用' : runtime.state}
          </div>
          <div style={{ color: 'var(--text-light)' }}>最近启动：{formatWhen(runtime.startedAt)}</div>
        </div>

        <div
          className="rounded-[12px] border px-3 py-2"
          style={{ borderColor, background: 'rgba(255,255,255,0.68)' }}
        >
          <div style={{ color: 'var(--text-light)' }}>Chromium 供应</div>
          <div className="mt-1 font-medium" style={{ color: 'var(--text-title)' }}>
            {!rsshubRequired ? '按需启动' : chromium.ready ? chromiumSourceLabel(chromium.source) : '未就绪'}
          </div>
          <div style={{ color: 'var(--text-light)' }}>
            下载能力：{chromium.downloadSupported === null ? '未检测' : chromium.downloadSupported ? '可下载' : '不可下载'}
          </div>
        </div>

        <div
          className="rounded-[12px] border px-3 py-2"
          style={{ borderColor, background: 'rgba(255,255,255,0.68)' }}
        >
          <div style={{ color: 'var(--text-light)' }}>最近更新</div>
          <div className="mt-1 font-medium" style={{ color: 'var(--text-title)' }}>
            {update.running ? '更新中' : `${update.insertedCount} 条新增`}
          </div>
          <div style={{ color: 'var(--text-light)' }}>
            源数：{update.sourceCount} · 耗时：{update.durationMs ? `${Math.round(update.durationMs / 1000)}s` : '未记录'}
          </div>
        </div>
      </div>

      {blockingErrors.length > 0 ? (
        <div
          className="rounded-[12px] border px-3 py-2"
          style={{
            borderColor: 'rgba(245, 158, 11, 0.35)',
            background: 'rgba(255,251,235,0.88)',
          }}
        >
          <div className="mb-1 flex items-center gap-2 text-[11px] font-medium" style={{ color: 'var(--color-orange)' }}>
            <AlertTriangle className="h-3.5 w-3.5" />
            当前阻塞
          </div>
          <div className="space-y-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {blockingErrors.map((item) => (
              <div key={item}>{item}</div>
            ))}
          </div>
        </div>
      ) : (
        <div
          className="flex items-center gap-2 rounded-[12px] border px-3 py-2 text-[11px]"
          style={{
            borderColor: 'rgba(34, 197, 94, 0.24)',
            background: 'rgba(240,253,244,0.72)',
            color: 'var(--text-secondary)',
          }}
        >
          <Sparkles className="h-3.5 w-3.5" style={{ color: 'var(--color-green)' }} />
          RSSHub、Chromium 和最近一次更新目前都没有结构化错误。
        </div>
      )}

      {runtime.running && runtimeError ? (
        <div
          className="rounded-[12px] border px-3 py-2 text-[11px]"
          style={{
            borderColor: 'rgba(245, 158, 11, 0.2)',
            background: 'rgba(255,251,235,0.56)',
            color: 'var(--text-secondary)',
          }}
        >
          <div className="mb-1 font-medium" style={{ color: 'var(--text-title)' }}>最近运行错误</div>
          <div>{runtimeError}</div>
          <div style={{ color: 'var(--text-light)' }}>记录时间：{formatWhen(runtime.lastRuntimeErrorAt)}</div>
        </div>
      ) : null}

      {diagnostics?.artifacts.benchmarkMarkdown ? (
        <div
          className="rounded-[12px] border px-3 py-2 text-[11px]"
          style={{
            borderColor: 'rgba(59,130,246,0.18)',
            background: 'rgba(239,246,255,0.5)',
            color: 'var(--text-secondary)',
          }}
        >
          <div className="mb-1 font-medium" style={{ color: 'var(--text-title)' }}>最近基准报告</div>
          <div className="truncate">{diagnostics.artifacts.benchmarkMarkdown}</div>
        </div>
      ) : null}
    </div>
  )
}
