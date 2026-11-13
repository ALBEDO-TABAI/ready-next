import { AlertTriangle, ArrowRight, RefreshCw, RotateCcw } from 'lucide-react'

import type { BrowserDiagnosticsData } from '../../modules/browser/types'
import { Button, IconButton } from '../ui'

interface BrowserDiagnosticsDockProps {
  browserDiagnostics: BrowserDiagnosticsData | null
  onContinue: () => void
  onRetry: () => void
  onOpenTarget: () => void
  onRefresh: () => void
}

export default function BrowserDiagnosticsDock({
  browserDiagnostics,
  onContinue,
  onRetry,
  onOpenTarget,
  onRefresh,
}: BrowserDiagnosticsDockProps) {
  const currentTask = browserDiagnostics?.currentTask || null
  const pageState = browserDiagnostics?.pageState || null
  const continuity = browserDiagnostics?.continuity || null
  const lastFailure = browserDiagnostics?.lastFailure || null
  const rendererProcesses = browserDiagnostics?.rendererProcesses || []
  const tabLoadStates = browserDiagnostics?.tabLoadStates || []
  const totalCpu = rendererProcesses.reduce((sum, process) => sum + process.cpuPercent, 0)
  const totalMemoryMB = rendererProcesses.reduce((sum, process) => sum + process.memoryKB, 0) / 1024
  const loadStateCounts = tabLoadStates.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.state] = (counts[entry.state] || 0) + 1
    return counts
  }, {})
  const eventCount = Object.values(browserDiagnostics?.eventCounts60s || {})
    .reduce((sum, count) => sum + count, 0)

  if (!currentTask && !lastFailure && !pageState && !continuity) return null

  return (
    <div
      data-ready-native-overlay=""
      // A float (W1 §4): the material brings the surface, the shadow and the blur.
      className="rn-float pointer-events-auto absolute bottom-4 right-4 z-[32] w-[320px] px-4 py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--rn-ink-3)' }}>
            浏览器任务与性能诊断
          </div>
          <div className="mt-1 truncate text-[15px] font-medium" style={{ color: 'var(--rn-ink)' }}>
            {currentTask?.taskTitle || '最近浏览器任务'}
          </div>
          <div className="mt-1 text-[12px]" style={{ color: 'var(--rn-ink)', lineHeight: 1.5 }}>
            {currentTask?.blockedReason || currentTask?.taskSummary || lastFailure?.reason || '当前没有阻塞信息'}
          </div>
        </div>

        <IconButton icon={<RefreshCw />} title="刷新诊断" onClick={onRefresh} />
      </div>

      {currentTask?.recentEvidence?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {currentTask.recentEvidence.slice(0, 3).map((item) => (
            <span
              key={item}
              className="rounded-full px-2 py-1 text-[11px]"
              style={{ background: 'var(--rn-fill-2)', color: 'var(--rn-ink-3)' }}
            >
              {item}
            </span>
          ))}
        </div>
      ) : null}

      {(pageState || continuity) && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]" style={{ color: 'var(--rn-ink-3)' }}>
          <div>目标页：{pageState?.targetMatched ? '已对齐' : '待确认'}</div>
          <div>附件：{pageState?.uploadComplete ? '已挂载' : '未完成'}</div>
          <div>提示词：{pageState?.promptComplete ? '已写入' : '未确认'}</div>
          <div>运行态：{pageState?.running ? '已开始' : '未开始'}</div>
          <div>可复用：{pageState?.canReuseCurrentPage || continuity?.canResume ? '可以' : '需要重整'}</div>
          <div>模式页：{pageState?.modeSelection ? '是' : '否'}</div>
        </div>
      )}

      <div
        className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl px-3 py-2 text-[11px]"
        style={{ background: 'var(--rn-fill-2)', color: 'var(--rn-ink-2)' }}
      >
        <div>页面进程：{rendererProcesses.length}</div>
        <div>内存：{totalMemoryMB.toFixed(1)} MB</div>
        <div>CPU：{totalCpu.toFixed(1)}%</div>
        <div>近 60 秒事件：{eventCount}</div>
        <div>前台：{loadStateCounts.visible || 0}</div>
        <div>后台降载：{loadStateCounts.throttled || 0}</div>
        <div>任务保护：{loadStateCounts['protected-background'] || 0}</div>
        <div>休眠：{loadStateCounts.dormant || 0}</div>
      </div>

      {lastFailure?.reason ? (
        <div
          className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-[11px]"
          style={{ background: 'color-mix(in srgb, var(--rn-bad) 9%, transparent)', color: 'var(--rn-ink)' }}
        >
          <AlertTriangle style={{ width: 14, height: 14, color: 'var(--rn-bad)', flexShrink: 0, marginTop: 1 }} strokeWidth={2} />
          <span>{lastFailure.reason}</span>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<ArrowRight />} onClick={onContinue}>继续</Button>
        <Button size="sm" icon={<RotateCcw />} onClick={onRetry}>重试</Button>
        <Button size="sm" icon={<ArrowRight />} onClick={onOpenTarget}>回到目标页</Button>
      </div>
    </div>
  )
}
