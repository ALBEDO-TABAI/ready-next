import { ArrowLeft, ArrowRight, Loader2, RefreshCw } from 'lucide-react'
import type { RefreshDockMode } from '../../modules/browser/useBrowserHeaderInteraction'
import { IconButton } from '../ui'

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
      <IconButton
        icon={loading ? <Loader2 className="animate-spin" style={{ color: 'var(--rn-ink-3)' }} /> : <RefreshCw />}
        onClick={onRefresh}
        title="刷新"
      />

      <IconButton
        icon={<ArrowLeft />}
        onClick={onGoBack}
        disabled={!canGoBack}
        style={refreshDockMode === 'revealed' ? undefined : { opacity: 0.001 }}
        title="后退"
      />

      <IconButton
        icon={<ArrowRight />}
        onClick={onGoForward}
        disabled={!canGoForward}
        style={refreshDockMode === 'revealed' ? undefined : { opacity: 0.001 }}
        title="前进"
      />
    </div>
  )
}
