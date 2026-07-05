import { useState, useEffect, useCallback } from 'react'
import { CheckCircle2, FileArchive, Loader2, Trash2, XCircle } from 'lucide-react'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_DANGER_BUTTON_STYLE,
  SETTINGS_INPUT_STYLE,
  SETTINGS_SECONDARY_BUTTON_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
} from '../../components/settings/settings-theme'
import { SETTINGS_ROW_CONTROL_MIN_WIDTH } from './settings-shared'

// Storage / cache panel — wired to app:getCacheStats + app:clearCache.
// Replaces the legacy hardcoded "256 MB" display. Shows live breakdown of
// userData cache subdirectories and lets the user clear them.
type CacheQuotaOption = '256MB' | '1GB' | '5GB' | 'unlimited'

const CACHE_QUOTA_OPTIONS: { value: CacheQuotaOption; label: string }[] = [
  { value: '256MB', label: '256 MB' },
  { value: '1GB', label: '1 GB' },
  { value: '5GB', label: '5 GB' },
  { value: 'unlimited', label: '无限制' },
]

const DEFAULT_CACHE_QUOTA: CacheQuotaOption = '1GB'

function isValidQuota(value: string | null | undefined): value is CacheQuotaOption {
  return value === '256MB' || value === '1GB' || value === '5GB' || value === 'unlimited'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

interface CacheStatsView {
  codeCacheBytes: number
  cacheBytes: number
  puppeteerCacheBytes: number
  sharedCacheBytes: number
}

const ZERO_STATS: CacheStatsView = {
  codeCacheBytes: 0,
  cacheBytes: 0,
  puppeteerCacheBytes: 0,
  sharedCacheBytes: 0,
}

// Exported for the Y0.8 relabel behavior test (per sub-plan
// docs/superpowers/plans/archive/2026-05-23-Y0-8-cache-quota-relabel-implementation.md §6).
// Mounting the full Settings page would require a ~200 line electronAPI proxy
// harness; exporting this single panel keeps the test surgical.
export function StorageSettingsPanel() {
  const [stats, setStats] = useState<CacheStatsView | null>(null)
  const [statsLoading, setStatsLoading] = useState<boolean>(true)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [clearing, setClearing] = useState<'none' | 'standard' | 'puppeteer'>('none')
  const [confirmKind, setConfirmKind] = useState<'standard' | 'puppeteer' | null>(null)
  const [lastResult, setLastResult] = useState<{ kind: 'standard' | 'puppeteer'; clearedBytes: number; errors: string[] } | null>(null)
  const [diagnosticExporting, setDiagnosticExporting] = useState<boolean>(false)
  const [diagnosticResult, setDiagnosticResult] = useState<{ path?: string; bytes?: number; error?: string } | null>(null)
  const [quota, setQuota] = useState<CacheQuotaOption>(DEFAULT_CACHE_QUOTA)

  const refreshStats = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.app?.getCacheStats) {
      setStatsLoading(false)
      setStatsError('IPC 不可用')
      return
    }
    setStatsLoading(true)
    setStatsError(null)
    try {
      const result = await window.electronAPI.app.getCacheStats()
      if (result.success && result.data) {
        setStats(result.data)
      } else {
        setStats(ZERO_STATS)
        setStatsError(result.error || '读取缓存大小失败')
      }
    } catch (err) {
      setStats(ZERO_STATS)
      setStatsError(err instanceof Error ? err.message : String(err))
    } finally {
      setStatsLoading(false)
    }
  }, [])

  // Load on mount + load persisted quota choice.
  useEffect(() => {
    void refreshStats()
  }, [refreshStats])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.settings) return
    let cancelled = false
    void (async () => {
      const result = await window.electronAPI.settings.get('cache_quota_bytes')
      if (cancelled) return
      if (result?.success && isValidQuota(result.data)) {
        setQuota(result.data)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const handleQuotaChange = useCallback(async (next: CacheQuotaOption) => {
    setQuota(next)
    if (typeof window === 'undefined' || !window.electronAPI?.settings) return
    // TODO(D1-quota): wire actual eviction. For now we just persist the choice
    // — Chromium cache cannot be hard-bounded via Electron API directly.
    void window.electronAPI.settings.set('cache_quota_bytes', next)
  }, [])

  const performClear = useCallback(async (includePuppeteer: boolean) => {
    if (typeof window === 'undefined' || !window.electronAPI?.app?.clearCache) return
    setClearing(includePuppeteer ? 'puppeteer' : 'standard')
    setConfirmKind(null)
    try {
      const result = await window.electronAPI.app.clearCache({ includePuppeteer })
      if (result.success && result.data) {
        setLastResult({
          kind: includePuppeteer ? 'puppeteer' : 'standard',
          clearedBytes: result.data.clearedBytes,
          errors: result.data.errors,
        })
      } else {
        setLastResult({
          kind: includePuppeteer ? 'puppeteer' : 'standard',
          clearedBytes: 0,
          errors: [result.error || '清除失败'],
        })
      }
      await refreshStats()
    } catch (err) {
      setLastResult({
        kind: includePuppeteer ? 'puppeteer' : 'standard',
        clearedBytes: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      })
    } finally {
      setClearing('none')
    }
  }, [refreshStats])

  const exportDiagnosticPack = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.app?.exportDiagnosticPack) {
      setDiagnosticResult({ error: 'IPC 不可用' })
      return
    }
    setDiagnosticExporting(true)
    setDiagnosticResult(null)
    try {
      const result = await window.electronAPI.app.exportDiagnosticPack()
      if (result.success && result.data) {
        setDiagnosticResult({
          path: result.data.path,
          bytes: result.data.bytes,
        })
      } else {
        setDiagnosticResult({ error: result.error || '导出失败' })
      }
    } catch (err) {
      // silent-catch: export failures are surfaced in the diagnostics panel.
      setDiagnosticResult({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setDiagnosticExporting(false)
    }
  }, [])

  const totalBytes = stats
    ? stats.codeCacheBytes + stats.cacheBytes + stats.puppeteerCacheBytes + stats.sharedCacheBytes
    : 0

  const breakdownRows: { id: string; label: string; description: string; bytes: number }[] = stats
    ? [
        { id: 'codeCache', label: 'Code Cache', description: 'Chromium V8 编译缓存', bytes: stats.codeCacheBytes },
        { id: 'cache', label: 'HTTP Cache', description: 'Electron 网络缓存', bytes: stats.cacheBytes },
        { id: 'sharedCache', label: 'Shared Dictionary', description: 'Brotli 压缩字典', bytes: stats.sharedCacheBytes },
        { id: 'puppeteerCache', label: 'Puppeteer Cache', description: 'Puppeteer 下载的 Chrome 二进制', bytes: stats.puppeteerCacheBytes },
      ]
    : []

  return (
    <div className="flex flex-col gap-7">
      {/* Cache breakdown summary */}
      <div
        className="glass-surface-card rounded-2xl border"
        style={{
          ...SETTINGS_CARD_STYLE,
          padding: '18px 20px',
        }}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
              缓存占用
            </div>
            <div className="text-[11px] mt-1" style={{ color: 'var(--text-light)' }}>
              当前 userData 下的缓存合计大小
            </div>
          </div>
          <div className="text-[18px] font-mono font-semibold" style={{ color: 'var(--text-title)' }}>
            {statsLoading ? '…' : formatBytes(totalBytes)}
          </div>
        </div>
        {statsError && (
          <div className="text-[11px] mt-2" style={{ color: 'var(--color-red, #d44)' }}>
            {statsError}
          </div>
        )}
        <div className="mt-4 flex flex-col gap-2">
          {breakdownRows.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[12px] font-medium" style={{ color: 'var(--text-body)' }}>
                  {row.label}
                </div>
                <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-light)' }}>
                  {row.description}
                </div>
              </div>
              <div className="text-[12px] font-mono" style={{ color: 'var(--text-muted)' }}>
                {statsLoading ? '…' : formatBytes(row.bytes)}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between transition-colors">
        <div className="flex-1 min-w-0 mr-4">
          <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
            报错信息包
          </div>
          <div className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
            导出最近日志、运行状态和脱敏配置，方便定位打包版问题
          </div>
          {diagnosticResult && (
            <div
              className="mt-2 text-[11px] leading-5 break-all"
              style={{ color: diagnosticResult.error ? 'var(--color-red, #d44)' : 'var(--text-muted)' }}
            >
              {diagnosticResult.error
                ? diagnosticResult.error
                : `已导出：${diagnosticResult.path}${diagnosticResult.bytes ? `（${formatBytes(diagnosticResult.bytes)}）` : ''}`}
            </div>
          )}
        </div>
        <button
          onClick={() => { void exportDiagnosticPack() }}
          disabled={diagnosticExporting}
          className="flex-shrink-0 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
          style={{
            ...SETTINGS_SECONDARY_BUTTON_STYLE,
            minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH,
            justifyContent: 'center',
            opacity: diagnosticExporting ? 0.6 : 1,
            cursor: diagnosticExporting ? 'not-allowed' : 'pointer',
          }}
        >
          {diagnosticExporting
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <FileArchive className="w-3 h-3" />}
          {diagnosticExporting ? '导出中…' : '导出'}
        </button>
      </div>

      {/* Quota selector — relabel-only per Stage Y0.8 plan §11.0a path-(b).
          The configured value still persists via cache_quota_bytes so it
          carries forward into Stage Z's real eviction landing; this UI is
          honest that no enforcement happens today. EN equivalent for future
          locale work: "Cache size limit (configured but NOT enforced —
          manual cleanup required)". */}
      <div className="flex items-center justify-between transition-colors">
        <div className="flex-1 min-w-0 mr-4">
          <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
            缓存大小上限
          </div>
          <div className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
            仅记录配置，未强制执行 — 需要手动清理（使用下方的「清除缓存」按钮）
          </div>
        </div>
        <select
          value={quota}
          onChange={(e) => { void handleQuotaChange(e.target.value as CacheQuotaOption) }}
          className="flex-shrink-0 rounded-lg border text-[12px] focus:outline-none focus:ring-2 focus:ring-[var(--color-blue)]/30 transition-[box-shadow,border-color,background-color] duration-200 cursor-pointer"
          style={{
            ...SETTINGS_INPUT_STYLE,
            padding: '9px 32px 9px 14px',
            width: 'auto',
            minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH,
          }}
        >
          {CACHE_QUOTA_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Standard clear */}
      <div className="flex items-center justify-between transition-colors">
        <div className="flex-1 min-w-0 mr-4">
          <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
            清除缓存
          </div>
          <div className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
            清除 Code Cache / HTTP Cache / Shared Dictionary 与会话级 Chromium 缓存
          </div>
        </div>
        <button
          onClick={() => setConfirmKind('standard')}
          disabled={clearing !== 'none' || statsLoading}
          className="flex-shrink-0 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
          style={{
            ...SETTINGS_DANGER_BUTTON_STYLE,
            minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH,
            justifyContent: 'center',
            opacity: clearing !== 'none' || statsLoading ? 0.6 : 1,
            cursor: clearing !== 'none' || statsLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {clearing === 'standard'
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <Trash2 className="w-3 h-3" />}
          {clearing === 'standard' ? '清除中…' : '清除'}
        </button>
      </div>

      {/* Puppeteer clear (gated separately) */}
      <div className="flex items-center justify-between transition-colors">
        <div className="flex-1 min-w-0 mr-4">
          <div className="text-[13px] font-medium" style={{ color: 'var(--text-title)' }}>
            包括浏览器缓存
          </div>
          <div className="text-[12px] mt-1 leading-5" style={{ color: 'var(--text-light)' }}>
            额外清除 puppeteer-cache（会重新下载 Chrome，约数百 MB）
          </div>
        </div>
        <button
          onClick={() => setConfirmKind('puppeteer')}
          disabled={clearing !== 'none' || statsLoading}
          className="flex-shrink-0 flex items-center gap-1.5 rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
          style={{
            ...SETTINGS_SECONDARY_BUTTON_STYLE,
            minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH,
            justifyContent: 'center',
            opacity: clearing !== 'none' || statsLoading ? 0.6 : 1,
            cursor: clearing !== 'none' || statsLoading ? 'not-allowed' : 'pointer',
          }}
        >
          {clearing === 'puppeteer'
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <Trash2 className="w-3 h-3" />}
          {clearing === 'puppeteer' ? '清除中…' : '清除全部'}
        </button>
      </div>

      {/* Result toast */}
      {lastResult && (
        <div
          className="glass-surface-card rounded-2xl border"
          style={{
            ...SETTINGS_SUBTLE_CARD_STYLE,
            padding: '12px 14px',
          }}
        >
          <div className="flex items-center gap-2">
            {lastResult.errors.length === 0
              ? <CheckCircle2 className="w-3.5 h-3.5" style={{ color: 'var(--color-green)' }} />
              : <XCircle className="w-3.5 h-3.5" style={{ color: 'var(--color-red, #d44)' }} />}
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-body)' }}>
              {lastResult.errors.length === 0
                ? `已清除 ${formatBytes(lastResult.clearedBytes)}`
                : `部分失败：清除 ${formatBytes(lastResult.clearedBytes)}，${lastResult.errors.length} 个错误`}
            </span>
          </div>
          {lastResult.errors.length > 0 && (
            <ul className="mt-2 ml-5 list-disc text-[11px]" style={{ color: 'var(--text-light)' }}>
              {lastResult.errors.slice(0, 5).map((err, idx) => (
                <li key={idx}>{err}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Confirmation modal */}
      {confirmKind && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.32)' }}
          onClick={() => setConfirmKind(null)}
        >
          <div
            className="glass-surface-card rounded-2xl border"
            style={{
              ...SETTINGS_CARD_STYLE,
              padding: '20px 22px',
              width: 360,
              maxWidth: 'calc(100vw - 48px)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
              确认清除缓存
            </div>
            <div className="text-[12px] mt-2 leading-5" style={{ color: 'var(--text-light)' }}>
              {confirmKind === 'puppeteer'
                ? '此操作会删除所有缓存，包括 puppeteer-cache。下次启动浏览器自动化时会重新下载 Chrome（数百 MB），耗时较长。是否继续？'
                : '此操作会删除 Code Cache、HTTP Cache 与 Shared Dictionary。下次启动应用时会重新生成。是否继续？'}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmKind(null)}
                className="rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
                style={{
                  ...SETTINGS_SECONDARY_BUTTON_STYLE,
                  padding: '8px 14px',
                }}
              >
                取消
              </button>
              <button
                onClick={() => { void performClear(confirmKind === 'puppeteer') }}
                className="rounded-lg text-[12px] font-medium transition-[filter,transform,background-color,opacity] duration-200 hover:brightness-95 active:scale-[0.98]"
                style={{
                  ...SETTINGS_DANGER_BUTTON_STYLE,
                  padding: '8px 14px',
                }}
              >
                确认清除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
