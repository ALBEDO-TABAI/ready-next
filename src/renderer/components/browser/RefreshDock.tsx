import { ArrowLeft, ArrowRight, Loader2, RefreshCw } from 'lucide-react'
import type { RefreshDockMode } from '../../modules/browser/useBrowserHeaderInteraction'

interface RefreshDockProps {
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  refreshDockMode: RefreshDockMode
  visible: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
  onRefresh: () => void
  onGoBack: () => void
  onGoForward: () => void
}

export default function RefreshDock({
  loading,
  canGoBack,
  canGoForward,
  refreshDockMode,
  visible,
  onMouseEnter,
  onMouseLeave,
  onRefresh,
  onGoBack,
  onGoForward,
}: RefreshDockProps) {
  return (
    <div
      className="flex items-center flex-shrink-0"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        width: visible ? (refreshDockMode === 'revealed' ? 86 : 30) : 0,
        gap: visible && refreshDockMode === 'revealed' ? 6 : 0,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'width 180ms ease, gap 180ms ease, opacity 140ms ease',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={onRefresh}
        className="flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--bg-hover)]"
        title="刷新"
      >
        {loading ? (
          <Loader2 style={{ width: 14, height: 14 }} className="animate-spin text-[var(--color-blue)]" strokeWidth={2} />
        ) : (
          <RefreshCw style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
        )}
      </button>

      <button
        type="button"
        onClick={onGoBack}
        disabled={!canGoBack}
        className="flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-full transition-[background-color,opacity] duration-150 hover:bg-[var(--bg-hover)] disabled:opacity-30"
        style={{ opacity: refreshDockMode === 'revealed' ? 1 : 0.001 }}
        title="后退"
      >
        <ArrowLeft style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
      </button>

      <button
        type="button"
        onClick={onGoForward}
        disabled={!canGoForward}
        className="flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-full transition-[background-color,opacity] duration-150 hover:bg-[var(--bg-hover)] disabled:opacity-30"
        style={{ opacity: refreshDockMode === 'revealed' ? 1 : 0.001 }}
        title="前进"
      >
        <ArrowRight style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
      </button>
    </div>
  )
}
