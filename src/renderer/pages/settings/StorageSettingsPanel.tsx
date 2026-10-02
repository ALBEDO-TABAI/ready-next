import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Check, FileArchive, Loader2, Trash2 } from 'lucide-react'
import {
  SETTINGS_ROW_CONTROL_MIN_WIDTH,
  SettingsCard,
  SettingsNotice,
  SettingsRow,
  settingsButtonClass,
} from './settings-shared'

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

// 缓存构成条与图例共用的中性墨色梯度：强调色不参与数据可视化，只按占比深浅区分。
const BREAKDOWN_SHADES = [72, 46, 28, 14]

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

  const clearBusy = clearing !== 'none' || statsLoading

  return (
    <div className="flex flex-col gap-5">
      {/* Cache breakdown summary */}
      <SettingsCard
        title="缓存占用"
        description="当前 userData 下的缓存合计大小"
        actions={(
          <div className="sx-stat__value" style={{ fontSize: 24 }}>
            {statsLoading ? '…' : formatBytes(totalBytes)}
          </div>
        )}
      >
        <div className="sx-card__body" style={{ paddingTop: 4 }}>
          {statsError && (
            <div className="sx-text-danger mb-3 text-[12px]">
              {statsError}
            </div>
          )}
          <div
            className="flex h-[6px] w-full overflow-hidden rounded-full"
            style={{ background: 'var(--sx-track-bg)' }}
            aria-hidden
          >
            {totalBytes > 0 && breakdownRows.map((row, index) => (
              row.bytes > 0 && (
                <span
                  key={row.id}
                  className="h-full"
                  style={{
                    width: `${(row.bytes / totalBytes) * 100}%`,
                    minWidth: 3,
                    background: `color-mix(in srgb, var(--sx-ink) ${BREAKDOWN_SHADES[index]}%, transparent)`,
                    borderRight: '1.5px solid var(--sx-card-bg)',
                  }}
                />
              )
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3.5">
            {breakdownRows.map((row, index) => (
              <div key={row.id} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span
                    className="mt-[5px] h-2 w-2 shrink-0 rounded-[3px]"
                    style={{ background: `color-mix(in srgb, var(--sx-ink) ${BREAKDOWN_SHADES[index]}%, transparent)` }}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-medium" style={{ color: 'var(--sx-body)' }}>
                      {row.label}
                    </div>
                    <div className="sx-meta mt-0.5 truncate">
                      {row.description}
                    </div>
                  </div>
                </div>
                <div className="sx-mono shrink-0 text-[12px]" style={{ color: 'var(--sx-muted)' }}>
                  {statsLoading ? '…' : formatBytes(row.bytes)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard>
        <SettingsRow
          label="报错信息包"
          description={(
            <>
              导出最近日志、运行状态和脱敏配置，方便定位打包版问题
              {diagnosticResult && (
                <span
                  className={`mt-1 block break-all text-[11.5px] ${diagnosticResult.error ? 'sx-text-danger' : ''}`}
                  style={diagnosticResult.error ? undefined : { color: 'var(--sx-body)' }}
                >
                  {diagnosticResult.error
                    ? diagnosticResult.error
                    : `已导出：${diagnosticResult.path}${diagnosticResult.bytes ? `（${formatBytes(diagnosticResult.bytes)}）` : ''}`}
                </span>
              )}
            </>
          )}
        >
          <button
            type="button"
            onClick={() => { void exportDiagnosticPack() }}
            disabled={diagnosticExporting}
            aria-busy={diagnosticExporting || undefined}
            className={settingsButtonClass('secondary')}
            style={{ minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH }}
          >
            {diagnosticExporting
              ? <Loader2 className="animate-spin" />
              : <FileArchive />}
            {diagnosticExporting ? '导出中…' : '导出'}
          </button>
        </SettingsRow>

        {/* Quota selector — relabel-only per Stage Y0.8 plan §11.0a path-(b).
            The configured value still persists via cache_quota_bytes so it
            carries forward into Stage Z's real eviction landing; this UI is
            honest that no enforcement happens today. EN equivalent for future
            locale work: "Cache size limit (configured but NOT enforced —
            manual cleanup required)". */}
        <SettingsRow
          label="缓存大小上限"
          description="仅记录配置，未强制执行 — 需要手动清理（使用下方的「清除缓存」按钮）"
        >
          <select
            value={quota}
            aria-label="缓存大小上限"
            onChange={(e) => { void handleQuotaChange(e.target.value as CacheQuotaOption) }}
            className="sx-select"
            style={{ minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH }}
          >
            {CACHE_QUOTA_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </SettingsRow>

        {/* Standard clear */}
        <SettingsRow
          label="清除缓存"
          description="清除 Code Cache / HTTP Cache / Shared Dictionary 与会话级 Chromium 缓存"
        >
          <button
            type="button"
            onClick={() => setConfirmKind('standard')}
            disabled={clearBusy}
            aria-busy={clearing === 'standard' || undefined}
            className={settingsButtonClass('danger')}
            style={{ minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH }}
          >
            {clearing === 'standard'
              ? <Loader2 className="animate-spin" />
              : <Trash2 />}
            {clearing === 'standard' ? '清除中…' : '清除'}
          </button>
        </SettingsRow>

        {/* Puppeteer clear (gated separately) */}
        <SettingsRow
          label="包括浏览器缓存"
          description="额外清除 puppeteer-cache（会重新下载 Chrome，约数百 MB）"
        >
          <button
            type="button"
            onClick={() => setConfirmKind('puppeteer')}
            disabled={clearBusy}
            aria-busy={clearing === 'puppeteer' || undefined}
            className={settingsButtonClass('danger')}
            style={{ minWidth: SETTINGS_ROW_CONTROL_MIN_WIDTH }}
          >
            {clearing === 'puppeteer'
              ? <Loader2 className="animate-spin" />
              : <Trash2 />}
            {clearing === 'puppeteer' ? '清除中…' : '清除全部'}
          </button>
        </SettingsRow>
      </SettingsCard>

      {/* Result notice — 成功用墨色对勾的中性提示，失败才用红色发丝边 */}
      {lastResult && (
        <SettingsNotice
          tone={lastResult.errors.length === 0 ? 'plain' : 'danger'}
          icon={lastResult.errors.length === 0 ? Check : undefined}
          title={lastResult.errors.length === 0
            ? `已清除 ${formatBytes(lastResult.clearedBytes)}`
            : `部分失败：清除 ${formatBytes(lastResult.clearedBytes)}，${lastResult.errors.length} 个错误`}
        >
          {lastResult.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-[11.5px]">
              {lastResult.errors.slice(0, 5).map((err, idx) => (
                <li key={idx}>{err}</li>
              ))}
            </ul>
          )}
        </SettingsNotice>
      )}

      {/* Confirmation modal */}
      {confirmKind && createPortal(
        <div
          data-ready-native-overlay=""
          className="sx-scrim"
          onClick={() => setConfirmKind(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="storage-clear-confirm-title"
            className="sx-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div id="storage-clear-confirm-title" className="sx-card-title">
              确认清除缓存
            </div>
            <div className="mt-2 text-[12.5px] leading-[1.65]" style={{ color: 'var(--sx-muted)' }}>
              {confirmKind === 'puppeteer'
                ? '此操作会删除所有缓存，包括 puppeteer-cache。下次启动浏览器自动化时会重新下载 Chrome（数百 MB），耗时较长。是否继续？'
                : '此操作会删除 Code Cache、HTTP Cache 与 Shared Dictionary。下次启动应用时会重新生成。是否继续？'}
            </div>
            <div className="sx-dialog__actions">
              <button
                type="button"
                onClick={() => setConfirmKind(null)}
                className={settingsButtonClass('secondary')}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => { void performClear(confirmKind === 'puppeteer') }}
                className={settingsButtonClass('danger')}
              >
                确认清除
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
