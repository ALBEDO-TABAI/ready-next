import { lazy, Suspense, useEffect, useMemo } from 'react'
import type { WorkbenchMode } from '../../stores/useMode'

type ModeComponentProps = {
  isActive?: boolean
  isMotionSettled?: boolean
}

const loadBrowserMode = () => import('../../pages/modes/BrowserMode')
const loadDocumentMode = () => import('../../pages/modes/DocumentMode')
const loadRSSMode = () => import('../../pages/modes/RSSMode')
const loadCalendarMode = () => import('../../pages/modes/CalendarMode')

const BrowserMode = lazy(loadBrowserMode) as React.ComponentType<ModeComponentProps>
const DocumentMode = lazy(loadDocumentMode) as React.ComponentType<ModeComponentProps>
const RSSMode = lazy(loadRSSMode) as React.ComponentType<ModeComponentProps>
const CalendarMode = lazy(loadCalendarMode) as React.ComponentType<ModeComponentProps>

const MODE_COMPONENTS: Record<WorkbenchMode, React.ComponentType<ModeComponentProps>> = {
  browser: BrowserMode,
  document: DocumentMode,
  rss: RSSMode,
  calendar: CalendarMode,
}

const ALL_WORKBENCH_MODES: WorkbenchMode[] = ['browser', 'document', 'rss', 'calendar']
const ALWAYS_PREPARED_WORKBENCH_MODES: WorkbenchMode[] = ['rss']
const ALL_MODE_LOADERS = [loadBrowserMode, loadDocumentMode, loadRSSMode, loadCalendarMode]
let hasPreloadedWorkbenchModes = false

function ModeFallback({ mode }: { mode: WorkbenchMode }) {
  return (
    <div className="flex h-full items-center justify-center" style={{ background: 'transparent' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        加载中...
      </span>
    </div>
  )
}

export default function WorkbenchModeOutlet({
  mode,
  isMotionSettled = true,
}: {
  mode: WorkbenchMode
  isMotionSettled?: boolean
}) {
  // Eager load all modes on mount
  useEffect(() => {
    if (hasPreloadedWorkbenchModes) return
    hasPreloadedWorkbenchModes = true
    ALL_MODE_LOADERS.forEach((loadMode) => {
      void loadMode()
    })
  }, [])

  const activeIndex = useMemo(() => {
    return ALL_WORKBENCH_MODES.indexOf(mode)
  }, [mode])

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{
        background: 'transparent',
      }}
    >
      {/* 水平滚动容器 - 所有模式常驻 */}
      <div
        className="flex h-full w-full"
        style={{
          transform: `translateX(-${activeIndex * 100}%)`,
          transition: isMotionSettled
            ? 'none'
            : 'transform 0.35s cubic-bezier(0.24, 1, 0.36, 1)',
          willChange: isMotionSettled ? 'auto' : 'transform',
        }}
      >
        {ALL_WORKBENCH_MODES.map((modeKey, index) => {
          const ModeComponent = MODE_COMPONENTS[modeKey]
          const isActive = index === activeIndex

          // 相邻模式视为"即将激活"，提前准备
          const isAdjacent = Math.abs(index - activeIndex) <= 1
          const shouldKeepPrepared = ALWAYS_PREPARED_WORKBENCH_MODES.includes(modeKey)
          const shouldPrepare = isAdjacent || shouldKeepPrepared

          return (
            <div
              key={modeKey}
              className="h-full w-full flex-shrink-0 flex-grow-0 overflow-hidden"
              style={{
                // 非当前模式降低渲染优先级
                contentVisibility: shouldPrepare ? 'auto' : 'hidden',
                contain: 'strict',
                // 关键修复：非激活模式完全隐藏，防止视觉残留（如 document-path-bar）
                visibility: shouldPrepare ? 'visible' : 'hidden',
                pointerEvents: isActive ? 'auto' : 'none',
              }}
              data-workbench-mode-panel={modeKey}
              aria-hidden={!isActive}
            >
              <Suspense fallback={<ModeFallback mode={modeKey} />}>
                <ModeComponent
                  isActive={isActive}
                  isMotionSettled={isActive ? isMotionSettled : false}
                />
              </Suspense>
            </div>
          )
        })}
      </div>
    </div>
  )
}
