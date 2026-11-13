import type { RefObject } from 'react'
import { Globe, Plus } from 'lucide-react'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'
import BrowserHeader from './BrowserHeader'
import { Button } from '../ui'

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
          {/* The browser's one panel (V11), as BrowserMode draws it: the head row, then the page framed by the panel. */}
          <div className="rn-panel browser-panel">
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

            <div className="rn-panel__body browser-panel__body" data-framed="true">
              {/* Where the page will show: the same box, radius and opaque ground as the page and its stand-ins. */}
              <div ref={contentRef} className="browser-page browser-page--empty">
                <div className="text-center">
                  <Globe className="mx-auto mb-4 h-16 w-16 opacity-20" strokeWidth={1.5} />
                  <p className="mb-2 text-[15px] leading-[24px] font-medium" style={{ color: 'var(--rn-ink-2)' }}>
                    {loading ? '浏览器启动中…' : '当前没有打开的标签页'}
                  </p>
                  {!loading && (
                    <Button icon={<Plus />} onClick={() => void onNewTab()}>
                      点击 + 新建标签页
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
