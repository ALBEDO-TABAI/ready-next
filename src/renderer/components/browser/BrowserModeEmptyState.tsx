import { Globe, Plus } from 'lucide-react'

import { WORKBENCH_HEADER_EDGE_X, WORKBENCH_TAB_ROW_HEIGHT } from '../../modules/workbench/chrome'

export default function BrowserModeEmptyState({
  onNewTab,
}: {
  onNewTab: () => void | Promise<void>
}) {
  return (
    <div className="workbench-mode-root">
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

      <div className="flex-1 flex items-center justify-center text-[var(--text-light)]">
        <div className="text-center">
          <Globe className="w-16 h-16 mx-auto mb-4 opacity-20" strokeWidth={1.5} />
          <p className="text-[14px] font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
            当前没有打开的标签页
          </p>
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
        </div>
      </div>
    </div>
  )
}
