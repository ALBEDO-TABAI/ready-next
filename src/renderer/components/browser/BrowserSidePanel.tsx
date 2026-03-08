import { Clock, ExternalLink, Globe, X } from 'lucide-react'
import type {
  AdblockState,
  BookmarkItem,
  DownloadItem,
  HistoryItem,
  PanelType,
} from '../../modules/browser/types'

interface BrowserSidePanelProps {
  activePanel: PanelType
  bookmarks: BookmarkItem[]
  selectedBookmarkUrl: string
  historyItems: HistoryItem[]
  downloads: DownloadItem[]
  adblockState: AdblockState
  onClose: () => void
  onNavigateFromPanel: (url: string) => void | Promise<void>
  onRemoveBookmark: (url: string) => void | Promise<void>
  onClearHistory: () => void | Promise<void>
  onClearDownloads: () => void | Promise<void>
  onSelectBookmark: (url: string) => void
  onToggleAdblock: () => void | Promise<void>
}

export default function BrowserSidePanel({
  activePanel,
  bookmarks,
  selectedBookmarkUrl,
  historyItems,
  downloads,
  adblockState,
  onClose,
  onNavigateFromPanel,
  onRemoveBookmark,
  onClearHistory,
  onClearDownloads,
  onSelectBookmark,
  onToggleAdblock,
}: BrowserSidePanelProps) {
  if (!activePanel) return null

  return (
    <aside
      className="content-surface-panel flex h-full w-[320px] flex-shrink-0 flex-col overflow-hidden border-l"
      style={{
        borderColor: 'var(--border-default)',
        background: 'var(--surface-panel-bg)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div
        className="glass-surface-panel flex items-center justify-between"
        style={{
          padding: '10px 14px',
          background: 'var(--surface-toolbar-bg)',
          borderBottom: '1px solid var(--border-default)',
        }}
      >
        <div>
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text-title)' }}>
            {activePanel === 'bookmarks' ? '收藏夹' : activePanel === 'downloads' ? '下载' : '历史记录'}
          </div>
          <div className="text-[10px]" style={{ color: 'var(--text-light)' }}>
            {activePanel === 'bookmarks'
              ? `${bookmarks.length} 条收藏`
              : activePanel === 'downloads'
                ? `${downloads.length} 条下载`
                : `${historyItems.length} 条记录`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {activePanel === 'bookmarks' && selectedBookmarkUrl && (
            <>
              <button
                onClick={() => void onNavigateFromPanel(selectedBookmarkUrl)}
                className="rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--color-blue)' }}
              >
                打开
              </button>
              <button
                onClick={() => void onRemoveBookmark(selectedBookmarkUrl)}
                className="rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--color-red)' }}
              >
                移除
              </button>
            </>
          )}
          {activePanel === 'history' && historyItems.length > 0 && (
            <button
              onClick={() => void onClearHistory()}
              className="rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--color-red)' }}
            >
              清空
            </button>
          )}
          {activePanel === 'downloads' && downloads.length > 0 && (
            <button
              onClick={() => void onClearDownloads()}
              className="rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--color-red)' }}
            >
              清空
            </button>
          )}
          <button
            onClick={onClose}
            className="flex items-center justify-center rounded hover:bg-[var(--bg-hover)] transition-colors"
            style={{ width: 22, height: 22 }}
          >
            <X style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
          </button>
        </div>
      </div>

      <div
        className="flex items-center justify-between border-b px-3 py-2"
        style={{
          borderColor: 'var(--border-default)',
          background: 'var(--surface-card-bg)',
        }}
      >
        <div>
          <div className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            Adblock
          </div>
          <div className="text-[10px]" style={{ color: 'var(--text-light)' }}>
            {adblockState.enabled ? '已开启' : '已关闭'} · 已拦截 {adblockState.networkBlockedCount} 次
          </div>
        </div>
        <button
          onClick={() => void onToggleAdblock()}
          className="rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: adblockState.enabled ? 'var(--color-blue)' : 'var(--color-orange)' }}
        >
          {adblockState.enabled ? '关闭' : '开启'}
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {activePanel === 'bookmarks' && (
          bookmarks.length === 0 ? (
            <div className="flex items-center justify-center py-8" style={{ color: 'var(--text-light)' }}>
              <div className="text-center">
                <Globe className="w-8 h-8 mx-auto mb-2 opacity-30" strokeWidth={1.5} />
                <p className="text-[12px]">暂无收藏</p>
              </div>
            </div>
          ) : (
            <div className="p-2">
              {bookmarks.map((item) => {
                const isSelected = selectedBookmarkUrl === item.url
                return (
                  <div
                    key={item.id}
                    className="mb-1 cursor-pointer rounded-[10px] border px-3 py-2 transition-colors hover:bg-[var(--bg-hover)]"
                    style={{
                      borderColor: isSelected ? 'var(--color-blue)' : 'transparent',
                      background: isSelected ? 'var(--color-blue-light)' : 'transparent',
                    }}
                    onClick={() => onSelectBookmark(item.url)}
                    onDoubleClick={() => void onNavigateFromPanel(item.url)}
                  >
                    <div className="flex items-center gap-3">
                      <Globe style={{ width: 14, height: 14, flexShrink: 0 }} className="text-[var(--text-gray)]" strokeWidth={2} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px]" style={{ color: 'var(--text-title)' }}>{item.title}</div>
                        <div className="truncate text-[10px]" style={{ color: 'var(--text-light)' }}>{item.url}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        )}

        {activePanel === 'history' && (
          historyItems.length === 0 ? (
            <div className="flex items-center justify-center py-8" style={{ color: 'var(--text-light)' }}>
              <div className="text-center">
                <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" strokeWidth={1.5} />
                <p className="text-[12px]">暂无历史记录</p>
              </div>
            </div>
          ) : (
            <div className="p-2">
              {historyItems.map((item) => (
                <div
                  key={item.id}
                  className="mb-1 flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 transition-colors hover:bg-[var(--bg-hover)]"
                  onClick={() => void onNavigateFromPanel(item.url)}
                >
                  <Globe style={{ width: 14, height: 14, flexShrink: 0 }} className="text-[var(--text-gray)]" strokeWidth={2} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px]" style={{ color: 'var(--text-title)' }}>{item.title}</div>
                    <div className="truncate text-[10px]" style={{ color: 'var(--text-light)' }}>{item.url}</div>
                  </div>
                  <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-light)' }}>
                    {new Date((item.last_visit_time || item.visited_at) * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          )
        )}

        {activePanel === 'downloads' && (
          downloads.length === 0 ? (
            <div className="flex items-center justify-center py-8" style={{ color: 'var(--text-light)' }}>
              <div className="text-center">
                <ExternalLink className="w-8 h-8 mx-auto mb-2 opacity-30" strokeWidth={1.5} />
                <p className="text-[12px]">暂无下载</p>
              </div>
            </div>
          ) : (
            <div className="p-2">
              {downloads.map((item) => (
                <div
                  key={item.id}
                  className="mb-1 rounded-[10px] px-3 py-2"
                  style={{ background: 'var(--surface-card-bg)' }}
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px]" style={{ color: 'var(--text-title)' }}>{item.filename}</div>
                      <div className="truncate text-[10px]" style={{ color: 'var(--text-light)' }}>
                        {item.state === 'completed' ? '已完成' : item.state === 'cancelled' ? '已取消' : '下载中...'}
                        {item.total_bytes > 0 && ` · ${(item.total_bytes / 1024 / 1024).toFixed(1)} MB`}
                        {item.mime_type ? ` · ${item.mime_type}` : ''}
                      </div>
                      {item.error && (
                        <div className="truncate text-[10px]" style={{ color: 'var(--color-red)' }}>
                          {item.error}
                        </div>
                      )}
                    </div>
                    <span
                      className="text-[10px] flex-shrink-0 px-2 py-0.5 rounded-full"
                      style={{
                        background: item.state === 'completed' ? 'var(--color-green-light)' : 'var(--bg-canvas)',
                        color: item.state === 'completed' ? 'var(--color-green)' : 'var(--text-light)',
                      }}
                    >
                      {item.state === 'completed' ? '完成' : item.state === 'cancelled' ? '取消' : `${Math.round((item.received_bytes / Math.max(item.total_bytes, 1)) * 100)}%`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </aside>
  )
}
