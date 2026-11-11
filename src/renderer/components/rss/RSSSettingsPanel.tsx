import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  CheckCircle2,
  Database,
  Download,
  Upload,
  ExternalLink,
  Loader2,
  RefreshCw,
  Settings,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react'
import type {
  RSSBenchmarkResultData,
  RSSDiagnosticsData,
  RSSSourceDiagnosticsEntry,
  RSSStatusData,
} from '../../modules/rss/types'
import {
  formatRSSRefreshInterval,
  getRSSRefreshRisk,
  RSS_AUTO_REFRESH_INTERVAL_KEY,
  RSS_REFRESH_INTERVAL_OPTIONS,
} from '../../modules/rss/settings'
import type { RSSSource } from './RSSFeed'

interface RSSDraftStoreSourceRow {
  sourceId: string
  sourceName: string
  sourceUrl: string
  platform: string
  storedCount: number
  inboxCount: number
  starredCount: number
  refreshMode: 'full' | 'incremental'
  lastFetchedAt: string | null
}

interface RSSSettingsPanelProps {
  open: boolean
  sources: RSSSource[]
  selectedSourceId: string | null
  autoRefreshIntervalMs: number
  onAutoRefreshIntervalChange: (intervalMs: number) => void
  onClose: () => void
  onReloadData: () => Promise<void> | void
  onOpenExternalServices: () => void
}

type NoticeKind = 'info' | 'success' | 'error'

interface NoticeState {
  kind: NoticeKind
  message: string
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '尚未刷新'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(ms: number | null | undefined): string {
  if (!Number.isFinite(ms) || !ms) return '暂无'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function runtimeStatusLabel(status: RSSStatusData | null, diagnostics: RSSDiagnosticsData | null): string {
  const state = diagnostics?.rsshub.state || status?.rsshub.state
  if (!state) return '未读取'
  if (state === 'running') return '运行中'
  if (state === 'starting') return '启动中'
  if (state === 'mock') return 'Mock'
  if (state === 'error') return '异常'
  return '未运行'
}

function runtimeStatusTone(status: RSSStatusData | null, diagnostics: RSSDiagnosticsData | null): string {
  const state = diagnostics?.rsshub.state || status?.rsshub.state
  if (state === 'running') return 'is-success'
  if (state === 'starting') return 'is-info'
  if (state === 'error') return 'is-danger'
  return 'is-muted'
}

function sourceHealthLabel(entry: RSSSourceDiagnosticsEntry | undefined): string {
  if (!entry) return '未检测'
  if (entry.lastRouteError) return '需处理'
  if (entry.lastSuccessAt) return '正常'
  if (entry.backendState === 'failing') return '失败'
  if (entry.backendState === 'conditional') return '条件可用'
  return '未测试'
}

function sourceHealthTone(entry: RSSSourceDiagnosticsEntry | undefined): string {
  if (!entry) return 'is-muted'
  if (entry.lastRouteError || entry.backendState === 'failing') return 'is-danger'
  if (entry.backendState === 'conditional') return 'is-warning'
  if (entry.lastSuccessAt || entry.backendState === 'stable') return 'is-success'
  return 'is-muted'
}

export default function RSSSettingsPanel({
  open,
  sources,
  selectedSourceId,
  autoRefreshIntervalMs,
  onAutoRefreshIntervalChange,
  onClose,
  onReloadData,
  onOpenExternalServices,
}: RSSSettingsPanelProps) {
  const [draftIntervalMs, setDraftIntervalMs] = useState(autoRefreshIntervalMs)
  const [status, setStatus] = useState<RSSStatusData | null>(null)
  const [diagnostics, setDiagnostics] = useState<RSSDiagnosticsData | null>(null)
  const [draftSources, setDraftSources] = useState<RSSDraftStoreSourceRow[]>([])
  const [benchmark, setBenchmark] = useState<RSSBenchmarkResultData | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [notice, setNotice] = useState<NoticeState | null>(null)
  const [hasLoaded, setHasLoaded] = useState(false)

  const riskyPlatforms = useMemo(() => sources.map((source) => source.platform), [sources])
  const refreshRisk = useMemo(
    () => getRSSRefreshRisk(draftIntervalMs, riskyPlatforms),
    [draftIntervalMs, riskyPlatforms],
  )

  const diagnosticsBySourceId = useMemo(() => {
    const map = new Map<string, RSSSourceDiagnosticsEntry>()
    for (const entry of diagnostics?.sources || []) {
      map.set(entry.sourceId, entry)
    }
    return map
  }, [diagnostics])

  const draftBySourceId = useMemo(() => {
    const map = new Map<string, RSSDraftStoreSourceRow>()
    for (const source of draftSources) {
      map.set(source.sourceId, source)
    }
    return map
  }, [draftSources])

  const sourceRows = useMemo(
    () =>
      sources.map((source) => ({
        source,
        draft: draftBySourceId.get(source.id),
        diagnostics: diagnosticsBySourceId.get(source.id),
      })),
    [diagnosticsBySourceId, draftBySourceId, sources],
  )

  useEffect(() => {
    setDraftIntervalMs(autoRefreshIntervalMs)
  }, [autoRefreshIntervalMs])

  const loadPanelData = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.rss) return
    setBusyKey((current) => current || 'load')
    try {
      const [statusResult, diagnosticsResult, draftsResult] = await Promise.all([
        window.electronAPI.rss.status(),
        window.electronAPI.rss.diagnostics(),
        window.electronAPI.rss.getDraftStoreSources(),
      ])

      if (statusResult.success && statusResult.data) {
        setStatus(statusResult.data)
      }
      if (diagnosticsResult.success && diagnosticsResult.data) {
        setDiagnostics(diagnosticsResult.data)
        setBenchmark(diagnosticsResult.data.benchmark)
      }
      if (draftsResult.success && draftsResult.data) {
        setDraftSources(draftsResult.data)
      }

      if (!statusResult.success || !diagnosticsResult.success || !draftsResult.success) {
        setNotice({
          kind: 'error',
          message:
            statusResult.error ||
            diagnosticsResult.error ||
            draftsResult.error ||
            '读取 RSS 设置状态失败',
        })
      } else {
        setNotice(null)
      }
      setHasLoaded(true)
    } finally {
      setBusyKey((current) => (current === 'load' ? null : current))
    }
  }, [])

  useEffect(() => {
    if (!open || hasLoaded) return
    void loadPanelData()
  }, [hasLoaded, loadPanelData, open])

  const saveRefreshInterval = useCallback(async () => {
    if (!window.electronAPI?.settings?.set) return
    setBusyKey('save-interval')
    try {
      const result = await window.electronAPI.settings.set(
        RSS_AUTO_REFRESH_INTERVAL_KEY,
        String(draftIntervalMs),
      )
      if (!result.success) {
        setNotice({ kind: 'error', message: result.error || '保存刷新频率失败' })
        return
      }
      onAutoRefreshIntervalChange(draftIntervalMs)
      setNotice({
        kind: 'success',
        message: `自动刷新已改为：${formatRSSRefreshInterval(draftIntervalMs)}`,
      })
    } finally {
      setBusyKey(null)
    }
  }, [draftIntervalMs, onAutoRefreshIntervalChange])

  const refreshRuntimeState = useCallback(async () => {
    setBusyKey('refresh-status')
    try {
      await loadPanelData()
      setNotice({ kind: 'success', message: 'RSS 状态已刷新' })
    } finally {
      setBusyKey(null)
    }
  }, [loadPanelData])

  const runBenchmark = useCallback(async () => {
    if (!window.electronAPI?.rss?.benchmarkSources) return
    setBusyKey('benchmark')
    try {
      const result = await window.electronAPI.rss.benchmarkSources(
        selectedSourceId ? { sourceIds: [selectedSourceId] } : undefined,
      )
      if (!result.success || !result.data) {
        setNotice({ kind: 'error', message: result.error || '测试订阅源失败' })
        return
      }
      setBenchmark(result.data)
      await loadPanelData()
      setNotice({
        kind: result.data.summary.failureCount > 0 ? 'info' : 'success',
        message: `测试完成：${result.data.summary.successCount}/${result.data.summary.sourceCount} 个源可用`,
      })
    } finally {
      setBusyKey(null)
    }
  }, [loadPanelData, selectedSourceId])

  const repairRuntime = useCallback(async () => {
    if (!window.electronAPI?.rss?.repairRuntime) return
    setBusyKey('repair-runtime')
    try {
      const result = await window.electronAPI.rss.repairRuntime()
      if (!result.success) {
        setNotice({ kind: 'error', message: result.error || '修复运行时失败' })
        return
      }
      await loadPanelData()
      setNotice({
        kind: result.data?.repaired ? 'success' : 'info',
        message: result.data?.repaired ? 'RSSHub 运行时已恢复' : '运行时已重新检查',
      })
    } finally {
      setBusyKey(null)
    }
  }, [loadPanelData])

  const exportOpml = useCallback(async () => {
    if (!window.electronAPI?.rss?.exportOpml) return
    setBusyKey('export-opml')
    try {
      const result = await window.electronAPI.rss.exportOpml()
      if (!result.success || !result.data) {
        setNotice({ kind: 'error', message: result.error || '导出 OPML 失败' })
        return
      }
      setNotice({ kind: 'success', message: `OPML 已导出：${result.data.path}` })
    } finally {
      setBusyKey(null)
    }
  }, [])

  // OPML import (W5-T6): sources already subscribed stay as they are; the file is read here, parsed and saved in Main.
  const opmlInput = useRef<HTMLInputElement>(null)
  const importOpml = useCallback(async (file: File) => {
    setBusyKey('import-opml')
    try {
      const result = await window.electronAPI.rss.importOpml({ xml: await file.text() })
      if (!result.success) {
        setNotice({ kind: 'error', message: result.error || '导入 OPML 失败' })
        return
      }
      const { added, existing } = result.data
      setNotice({ kind: 'success', message: added
        ? `已导入 ${added} 个订阅源${existing ? `，另有 ${existing} 个本来就在订阅里` : ''}`
        : `文件里的 ${existing} 个订阅源都已在订阅里，没有新增` })
      await loadPanelData()
      await onReloadData()
    } catch (cause) {
      // silent-catch: the failure is shown in the panel's notice; nothing was imported.
      setNotice({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setBusyKey(null)
    }
  }, [loadPanelData, onReloadData])

  const exportCurrentFeed = useCallback(async () => {
    if (!window.electronAPI?.rss?.exportFeed) return
    setBusyKey('export-feed')
    try {
      const result = await window.electronAPI.rss.exportFeed()
      if (!result.success || !result.data) {
        setNotice({ kind: 'error', message: result.error || '导出订阅合集失败' })
        return
      }
      setNotice({ kind: 'success', message: `订阅合集已导出：${result.data.path}` })
    } finally {
      setBusyKey(null)
    }
  }, [])

  const refreshSource = useCallback(
    async (source: RSSSource) => {
      if (!window.electronAPI?.rss?.refreshSource) return
      setBusyKey(`refresh-source:${source.id}`)
      try {
        const result = await window.electronAPI.rss.refreshSource(source.id)
        if (!result.success) {
          setNotice({ kind: 'error', message: result.error || `${source.name} 刷新失败` })
          return
        }
        await onReloadData()
        await loadPanelData()
        setNotice({
          kind: result.data?.errors?.length ? 'info' : 'success',
          message: result.data?.message || `${source.name} 已刷新`,
        })
      } finally {
        setBusyKey(null)
      }
    },
    [loadPanelData, onReloadData],
  )

  const clearDraftStore = useCallback(
    async (source: RSSSource) => {
      if (!window.electronAPI?.rss?.clearDraftStore) return
      setBusyKey(`clear-draft:${source.id}`)
      try {
        const result = await window.electronAPI.rss.clearDraftStore({ sourceId: source.id })
        if (!result.success) {
          setNotice({ kind: 'error', message: result.error || `${source.name} 底稿重置失败` })
          return
        }
        await onReloadData()
        await loadPanelData()
        setNotice({ kind: 'success', message: `${source.name} 的底稿已重置` })
      } finally {
        setBusyKey(null)
      }
    },
    [loadPanelData, onReloadData],
  )

  const isSavingInterval = busyKey === 'save-interval'
  const intervalChanged = draftIntervalMs !== autoRefreshIntervalMs
  const isInitialLoading = busyKey === 'load' && !hasLoaded

  if (!open) return null

  return (
    <aside
      className="rss-settings-drawer rss-settings-surface content-surface-panel ready-app-liquid-panel is-entered"
    >
      <div className="rss-settings-header">
        <div className="rss-settings-title">
          <Settings className="h-[15px] w-[15px]" strokeWidth={2} />
          RSS 设置
        </div>
        <button type="button" className="rss-settings-icon-button" onClick={onClose} title="关闭">
          <X className="h-[15px] w-[15px]" strokeWidth={2} />
        </button>
      </div>

      <div className="rss-settings-scroll panel-hover-scrollbar">
        {isInitialLoading ? (
          <div className="rss-settings-empty">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取 RSS 状态…
          </div>
        ) : null}

        <section className="rss-settings-card">
          <div className="rss-settings-section-title">
            <RefreshCw className="h-[14px] w-[14px]" />
            自动刷新
          </div>
          <div className="rss-settings-choice-grid">
            {RSS_REFRESH_INTERVAL_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`rss-settings-choice ${
                  draftIntervalMs === option.value ? 'is-active' : ''
                }`}
                onClick={() => setDraftIntervalMs(option.value)}
              >
                <span>{option.label}</span>
                <small>{option.helper}</small>
              </button>
            ))}
          </div>
          <div className={`rss-settings-warning is-${refreshRisk.level}`}>
            {refreshRisk.level === 'danger' || refreshRisk.level === 'warning' ? (
              <TriangleAlert className="h-[14px] w-[14px]" />
            ) : (
              <CheckCircle2 className="h-[14px] w-[14px]" />
            )}
            <div>
              <strong>{refreshRisk.title}</strong>
              <span>{refreshRisk.message}</span>
            </div>
          </div>
          <div className="rss-settings-actions">
            <button
              type="button"
              className="rss-settings-button is-primary"
              disabled={!intervalChanged || isSavingInterval}
              onClick={() => void saveRefreshInterval()}
            >
              {isSavingInterval ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              保存频率
            </button>
          </div>
        </section>

        <section className="rss-settings-card">
          <div className="rss-settings-section-title">
            <Activity className="h-[14px] w-[14px]" />
            订阅规则与运行时
          </div>
          <div className="rss-settings-runtime-grid">
            <div>
              <span>RSSHub</span>
              <strong>{runtimeStatusLabel(status, diagnostics)}</strong>
            </div>
            <div>
              <span>Chromium</span>
              <strong>{diagnostics?.rsshub.chromium.ready ? '可用' : '未就绪'}</strong>
            </div>
            <div>
              <span>最近刷新</span>
              <strong>{diagnostics?.update.finishedAt ? formatDateTime(diagnostics.update.finishedAt) : '暂无'}</strong>
            </div>
          </div>
          <div className="rss-settings-status-line">
            <span className={`rss-settings-status-pill ${runtimeStatusTone(status, diagnostics)}`}>
              {runtimeStatusLabel(status, diagnostics)}
            </span>
            <span>
              {diagnostics?.rsshub.baseUrl ||
                diagnostics?.rsshub.lastRuntimeError ||
                diagnostics?.rsshub.lastStartupError ||
                '运行状态会在打开面板时自动检查'}
            </span>
          </div>
          {benchmark ? (
            <div className="rss-settings-status-line">
              <span className="rss-settings-status-pill is-info">规则测试</span>
              <span>
                {benchmark.summary.successCount}/{benchmark.summary.sourceCount} 个源可用
                {benchmark.summary.failureCount > 0 ? `，${benchmark.summary.failureCount} 个失败` : ''}
              </span>
            </div>
          ) : null}
          <div className="rss-settings-actions">
            <button
              type="button"
              className="rss-settings-button"
              disabled={busyKey === 'refresh-status'}
              onClick={() => void refreshRuntimeState()}
            >
              {busyKey === 'refresh-status' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新状态
            </button>
            <button
              type="button"
              className="rss-settings-button"
              disabled={busyKey === 'benchmark'}
              onClick={() => void runBenchmark()}
            >
              {busyKey === 'benchmark' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
              测试订阅源
            </button>
            <button
              type="button"
              className="rss-settings-button"
              disabled={busyKey === 'repair-runtime'}
              onClick={() => void repairRuntime()}
            >
              {busyKey === 'repair-runtime' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
              修复运行时
            </button>
            <button type="button" className="rss-settings-button" onClick={onOpenExternalServices}>
              <ExternalLink className="h-3.5 w-3.5" />
              外部服务
            </button>
          </div>
        </section>

        <section className="rss-settings-card">
          <div className="rss-settings-section-title">
            <Database className="h-[14px] w-[14px]" />
            源状态与底稿
          </div>
          <div className="rss-settings-section-note">
            这里展示每个源的最近抓取、底稿数量和当前规则状态。
          </div>
          <div className="rss-settings-source-list">
            {sourceRows.length === 0 ? (
              <div className="rss-settings-empty">还没有 RSS 源</div>
            ) : (
              sourceRows.map(({ source, draft, diagnostics: sourceDiagnostics }) => {
                const refreshBusy = busyKey === `refresh-source:${source.id}`
                const clearBusy = busyKey === `clear-draft:${source.id}`
                return (
                  <div key={source.id} className="rss-settings-source-row">
                    <div className="rss-settings-source-main">
                      <div className="rss-settings-source-title" title={source.name}>
                        {source.name}
                      </div>
                      <div className="rss-settings-source-meta" title={source.url || draft?.sourceUrl}>
                        {source.platform || draft?.platform || 'rss'} · {formatDateTime(draft?.lastFetchedAt)}
                      </div>
                      {sourceDiagnostics?.lastRouteError ? (
                        <div className="rss-settings-source-error" title={sourceDiagnostics.lastRouteError.message}>
                          {sourceDiagnostics.lastRouteError.message}
                        </div>
                      ) : null}
                    </div>
                    <div className="rss-settings-source-side">
                      <span className={`rss-settings-status-pill ${sourceHealthTone(sourceDiagnostics)}`}>
                        {sourceHealthLabel(sourceDiagnostics)}
                      </span>
                      <div className="rss-settings-source-counts">
                        {draft?.storedCount ?? 0} 底稿 · {draft?.inboxCount ?? '—'} 收件箱
                      </div>
                      <div className="rss-settings-source-actions">
                        <button
                          type="button"
                          className="rss-settings-icon-button"
                          disabled={refreshBusy || clearBusy}
                          onClick={() => void refreshSource(source)}
                          title="刷新此源"
                        >
                          {refreshBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        </button>
                        <button
                          type="button"
                          className="rss-settings-icon-button is-danger"
                          disabled={refreshBusy || clearBusy}
                          onClick={() => void clearDraftStore(source)}
                          title="重置此源底稿"
                        >
                          {clearBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        <section className="rss-settings-card">
          <div className="rss-settings-section-title">
            <Download className="h-[14px] w-[14px]" />
            导入导出
          </div>
          <div className="rss-settings-section-note">
            导入 OPML 会把文件里的订阅源加进来，已有的不变；导出会写入 Ready 的 RSS 产物目录，不改变当前订阅源。
          </div>
          <div className="rss-settings-actions">
            <button
              type="button"
              className="rss-settings-button"
              disabled={busyKey === 'import-opml'}
              onClick={() => opmlInput.current?.click()}
            >
              {busyKey === 'import-opml' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              导入 OPML
            </button>
            <input ref={opmlInput} type="file" accept=".opml,.xml,text/xml,application/xml" hidden aria-label="选择 OPML 文件"
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importOpml(file) }} />
            <button
              type="button"
              className="rss-settings-button"
              disabled={busyKey === 'export-opml'}
              onClick={() => void exportOpml()}
            >
              {busyKey === 'export-opml' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              导出 OPML
            </button>
            <button
              type="button"
              className="rss-settings-button"
              disabled={busyKey === 'export-feed'}
              onClick={() => void exportCurrentFeed()}
            >
              {busyKey === 'export-feed' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              导出订阅合集
            </button>
          </div>
        </section>

        <section className="rss-settings-card">
          <div className="rss-settings-section-title">当前自动刷新</div>
          <div className="rss-settings-section-note">
            已生效：{formatRSSRefreshInterval(autoRefreshIntervalMs)}。面板里只保存全局频率，单个源仍使用统一调度。
          </div>
          <div className="rss-settings-section-note">
            最近测试耗时：{formatDuration(benchmark?.summary.p50DurationMs)} P50
          </div>
        </section>
      </div>

      {notice ? (
        <div className={`rss-settings-notice is-${notice.kind}`}>
          {notice.kind === 'error' ? (
            <TriangleAlert className="h-3.5 w-3.5" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          <span>{notice.message}</span>
        </div>
      ) : null}
    </aside>
  )
}
