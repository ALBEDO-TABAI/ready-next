import type { RefObject } from 'react'
import { Globe, Plus } from 'lucide-react'

import {
  WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM,
  WORKBENCH_CANVAS_OUTER_PADDING_TOP,
  WORKBENCH_CANVAS_OUTER_PADDING_X,
  WORKBENCH_HEADER_EDGE_X,
  WORKBENCH_TAB_ROW_HEIGHT,
} from '../../modules/workbench/chrome'

export default function BrowserModeEmptyState({
  onNewTab,
  contentRef,
  loading = false,
}: {
  onNewTab: () => void | Promise<void>
  contentRef: RefObject<HTMLDivElement | null>
  loading?: boolean
}) {
  return (
    <div className="workbench-mode-root">
      <div
        className="flex-1 min-h-0"
        style={{
          padding: `${WORKBENCH_CANVAS_OUTER_PADDING_TOP}px ${WORKBENCH_CANVAS_OUTER_PADDING_X}px ${WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM}px`,
        }}
      >
        <div className="workbench-canvas-shell flex h-full min-h-0 flex-col">
          <div
            className="glass-surface-panel flex items-center no-drag"
            style={{
              height: WORKBENCH_TAB_ROW_HEIGHT,
              padding: `0 ${WORKBENCH_HEADER_EDGE_X}px`,
              background: 'var(--bg-content)',
              borderBottom: '1px solid var(--border-default)',
            }}
          >
            <button
              onClick={() => void onNewTab()}
              className="flex items-center justify-center hover:bg-[var(--bg-hover)] transition-colors"
              style={{ width: 26, height: 26, borderRadius: 6 }}
              title="新建标签页"
            >
              <Plus style={{ width: 14, height: 14 }} className="text-[var(--text-muted)]" strokeWidth={2} />
            </button>
          </div>

          <div
            ref={contentRef}
            className="relative flex-1 min-h-0"
            style={{ borderRadius: '0 0 var(--workbench-canvas-radius) var(--workbench-canvas-radius)' }}
          >
            <div className="absolute inset-0 flex items-center justify-center text-[var(--text-light)]">
              <div className="text-center">
                <Globe className="w-16 h-16 mx-auto mb-4 opacity-20" strokeWidth={1.5} />
                <p className="text-[14px] font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
                  {loading ? '浏览器启动中…' : '当前没有打开的标签页'}
                </p>
                {!loading && (
                  <button
                    onClick={() => void onNewTab()}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-colors hover:bg-[var(--color-blue-light)]"
                    style={{
                      color: 'var(--color-blue)',
                      fontSize: 13,
                      border: '1px solid var(--color-blue)',
                      background: 'transparent',
                    }}
                  >
                    <Plus style={{ width: 14, height: 14 }} strokeWidth={2} />
                    点击 + 新建标签页
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
