import { useCallback, useEffect, useState } from 'react'
import type { RSSBenchmarkResultData, RSSDiagnosticsData, RSSStatusData } from './types'

interface UseRSSRuntimeDiagnosticsOptions {
  onStatusMessage?: (message: string) => void
}

export function useRSSRuntimeDiagnostics(options: UseRSSRuntimeDiagnosticsOptions = {}) {
  const { onStatusMessage } = options
  const [runtimeStatus, setRuntimeStatus] = useState<RSSStatusData | null>(null)
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RSSDiagnosticsData | null>(null)
  const [runtimeLoading, setRuntimeLoading] = useState(false)
  const [runtimeRepairing, setRuntimeRepairing] = useState(false)
  const [benchmarkResult, setBenchmarkResult] = useState<RSSBenchmarkResultData | null>(null)
  const [benchmarking, setBenchmarking] = useState(false)

  const loadRuntimeDiagnostics = useCallback(async () => {
    if (!window.electronAPI?.rss) return
    setRuntimeLoading(true)
    try {
      const [statusResult, diagnosticsResult] = await Promise.all([
        window.electronAPI.rss.status(),
        window.electronAPI.rss.diagnostics(),
      ])
      if (statusResult.success && statusResult.data) {
        setRuntimeStatus(statusResult.data)
      }
      if (diagnosticsResult.success && diagnosticsResult.data) {
        setRuntimeDiagnostics(diagnosticsResult.data)
        if (diagnosticsResult.data.benchmark) {
          setBenchmarkResult(diagnosticsResult.data.benchmark)
        }
      }
    } catch {
      // best-effort
    } finally {
      setRuntimeLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRuntimeDiagnostics()
  }, [loadRuntimeDiagnostics])

  useEffect(() => {
    let disposed = false
    const timer = window.setInterval(() => {
      if (!disposed) {
        void loadRuntimeDiagnostics()
      }
    }, 20_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [loadRuntimeDiagnostics])

  const runBenchmark = useCallback(async () => {
    if (!window.electronAPI?.rss?.benchmarkSources || benchmarking) return
    setBenchmarking(true)
    try {
      const result = await window.electronAPI.rss.benchmarkSources({ group: 'creator-watchlist' })
      if (result.success && result.data) {
        setBenchmarkResult(result.data)
        onStatusMessage?.(
          `基准完成：${result.data.summary.successCount}/${result.data.summary.sourceCount} 成功，p95 ${result.data.summary.p95DurationMs ? `${Math.round(result.data.summary.p95DurationMs)}ms` : '未记录'}`,
        )
      } else if (result.error) {
        onStatusMessage?.(`基准失败：${result.error}`)
      }
      await loadRuntimeDiagnostics()
    } catch (error) {
      onStatusMessage?.(error instanceof Error ? `基准失败：${error.message}` : '基准失败')
    } finally {
      setBenchmarking(false)
    }
  }, [benchmarking, loadRuntimeDiagnostics, onStatusMessage])

  const repairRuntime = useCallback(async () => {
    if (!window.electronAPI?.rss?.repairRuntime || runtimeRepairing) return
    setRuntimeRepairing(true)
    try {
      const result = await window.electronAPI.rss.repairRuntime()
      if (result.success && result.data?.rsshub) {
        setRuntimeStatus((prev) =>
          prev
            ? {
                ...prev,
                rsshub: result.data!.rsshub!,
              }
            : null,
        )
        onStatusMessage?.(result.data.repaired ? 'RSS 运行时已修复并重启' : 'RSS 运行时修复未完全成功')
      } else {
        onStatusMessage?.(`RSS 运行时修复失败：${result.error || '未知错误'}`)
      }
      await loadRuntimeDiagnostics()
    } catch (error) {
      onStatusMessage?.(error instanceof Error ? `RSS 运行时修复失败：${error.message}` : 'RSS 运行时修复失败')
    } finally {
      setRuntimeRepairing(false)
    }
  }, [loadRuntimeDiagnostics, onStatusMessage, runtimeRepairing])

  return {
    runtimeStatus,
    runtimeDiagnostics,
    runtimeLoading,
    runtimeRepairing,
    benchmarkResult,
    benchmarking,
    loadRuntimeDiagnostics,
    runBenchmark,
    repairRuntime,
  }
}
