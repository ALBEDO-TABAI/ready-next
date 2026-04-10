import { AlertTriangle, ArrowRight, RefreshCw, RotateCcw } from 'lucide-react'

import type { BrowserDiagnosticsData } from '../../modules/browser/types'

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

  if (!currentTask && !lastFailure && !pageState && !continuity) return null

  return (
    <div
      className="pointer-events-auto absolute bottom-4 right-4 z-[32] w-[320px] rounded-2xl border px-4 py-3 shadow-[0_18px_50px_rgba(15,23,42,0.12)]"
      style={{
        background: 'var(--surface-floating-bg)',
        borderColor: 'var(--surface-border)',
        backdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
        WebkitBackdropFilter: 'blur(var(--surface-blur)) saturate(var(--surface-saturate))',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--text-light)' }}>
            浏览器任务诊断
          </div>
          <div className="mt-1 truncate text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>
            {currentTask?.taskTitle || '最近浏览器任务'}
          </div>
          <div className="mt-1 text-[12px]" style={{ color: 'var(--text-body)', lineHeight: 1.5 }}>
            {currentTask?.blockedReason || currentTask?.taskSummary || lastFailure?.reason || '当前没有阻塞信息'}
          </div>
        </div>

        <button
          onClick={onRefresh}
          className="flex h-8 w-8 items-center justify-center rounded-xl transition-colors hover:bg-black/5"
          title="刷新诊断"
        >
          <RefreshCw style={{ width: 15, height: 15, color: 'var(--text-light)' }} strokeWidth={2} />
        </button>
      </div>

      {currentTask?.recentEvidence?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {currentTask.recentEvidence.slice(0, 3).map((item) => (
            <span
              key={item}
              className="rounded-full px-2 py-1 text-[10px]"
              style={{ background: 'var(--bg-hover)', color: 'var(--text-light)' }}
            >
              {item}
            </span>
          ))}
        </div>
      ) : null}

      {(pageState || continuity) && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]" style={{ color: 'var(--text-light)' }}>
          <div>目标页：{pageState?.targetMatched ? '已对齐' : '待确认'}</div>
          <div>附件：{pageState?.uploadComplete ? '已挂载' : '未完成'}</div>
          <div>提示词：{pageState?.promptComplete ? '已写入' : '未确认'}</div>
          <div>运行态：{pageState?.running ? '已开始' : '未开始'}</div>
          <div>可复用：{pageState?.canReuseCurrentPage || continuity?.canResume ? '可以' : '需要重整'}</div>
          <div>模式页：{pageState?.modeSelection ? '是' : '否'}</div>
        </div>
      )}

      {lastFailure?.reason ? (
        <div
          className="mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px]"
          style={{ borderColor: 'rgba(224, 69, 72, 0.22)', background: 'rgba(224, 69, 72, 0.08)', color: 'var(--text-body)' }}
        >
          <AlertTriangle style={{ width: 14, height: 14, color: 'var(--color-orange)', flexShrink: 0, marginTop: 1 }} strokeWidth={2} />
          <span>{lastFailure.reason}</span>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={onContinue}
          className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--color-blue)', border: '1px solid color-mix(in srgb, var(--color-blue) 24%, transparent)' }}
        >
          <ArrowRight style={{ width: 14, height: 14 }} strokeWidth={2} />
          继续
        </button>
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-body)', border: '1px solid var(--border-default)' }}
        >
          <RotateCcw style={{ width: 14, height: 14 }} strokeWidth={2} />
          重试
        </button>
        <button
          onClick={onOpenTarget}
          className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-body)', border: '1px solid var(--border-default)' }}
        >
          <ArrowRight style={{ width: 14, height: 14 }} strokeWidth={2} />
          回到目标页
        </button>
      </div>
    </div>
  )
}
