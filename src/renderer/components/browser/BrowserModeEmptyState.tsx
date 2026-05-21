import type { RefObject } from 'react'
import { Globe, Plus } from 'lucide-react'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'
import BrowserHeader from './BrowserHeader'

import {
  WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM,
  WORKBENCH_CANVAS_OUTER_PADDING_TOP,
  WORKBENCH_CANVAS_OUTER_PADDING_X,
} from '../../modules/workbench/chrome'

export default function BrowserModeEmptyState({
  onNewTab,
  contentRef,
  urlInput,
  onUrlChange,
  onNavigate,
  onFocus,
  onBlur,
  onEditStart,
  onEditEnd,
  loading = false,
  onShowUtilityMenu,
  fastCardOpen,
  fastCardItemCount,
  onToggleFastCard,
}: {
  onNewTab: () => void | Promise<void>
  contentRef: RefObject<HTMLDivElement | null>
  urlInput: string
  onUrlChange: (value: string) => void
  onNavigate: () => void
  onFocus: () => void
  onBlur: () => void
  onEditStart: () => void
  onEditEnd: () => void
  loading?: boolean
  onShowUtilityMenu: (kind: BrowserUtilityMenuKind, anchorRect: DOMRect) => void
  fastCardOpen: boolean
  fastCardItemCount: number
  onToggleFastCard: () => void
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
          <BrowserHeader
            isActive
            tabs={[]}
            activeTabId={null}
            splitTabId={null}
            urlInput={urlInput}
            bookmarkedUrls={[]}
            loading={loading}
            canGoBack={false}
            canGoForward={false}
            isBookmarked={false}
            onTabClick={() => undefined}
            onTabClose={() => undefined}
            onNewTab={onNewTab}
            onReorder={() => undefined}
            onUrlChange={onUrlChange}
            onNavigate={onNavigate}
            onGoBack={() => undefined}
            onGoForward={() => undefined}
            onRefresh={() => undefined}
            onFocus={onFocus}
            onBlur={onBlur}
            onEditStart={onEditStart}
            onEditEnd={onEditEnd}
            onToggleBookmark={() => undefined}
            onToggleBookmarkForTab={() => undefined}
            onShowUtilityMenu={onShowUtilityMenu}
            fastCardOpen={fastCardOpen}
            fastCardItemCount={fastCardItemCount}
            onToggleFastCard={onToggleFastCard}
          />

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
