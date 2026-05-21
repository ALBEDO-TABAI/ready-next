import {
  Bookmark,
  Download,
  MoreHorizontal,
  StickyNote,
} from 'lucide-react'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'

interface HeaderUtilityActionsProps {
  onShowUtilityMenu: (kind: BrowserUtilityMenuKind, anchorRect: DOMRect) => void
  fastCardOpen: boolean
  fastCardItemCount: number
  onToggleFastCard: () => void
}

export default function HeaderUtilityActions({
  onShowUtilityMenu,
  fastCardOpen,
  fastCardItemCount,
  onToggleFastCard,
}: HeaderUtilityActionsProps) {
  const toolbarBtn = 'flex h-[28px] w-[28px] items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-hover)] flex-shrink-0'

  return (
    <div className="flex items-center flex-shrink-0" style={{ gap: 2 }}>
      <button
        type="button"
        onClick={(event) => onShowUtilityMenu('bookmarks', event.currentTarget.getBoundingClientRect())}
        className={toolbarBtn}
        title="收藏夹"
      >
        <Bookmark style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
      </button>

      <button
        type="button"
        onClick={onToggleFastCard}
        className={`${toolbarBtn} relative`}
        title={fastCardItemCount > 0 ? `FastCard (${fastCardItemCount})` : 'FastCard'}
        aria-label={fastCardItemCount > 0 ? `FastCard，${fastCardItemCount} 条内容` : 'FastCard'}
        aria-pressed={fastCardOpen}
        style={{
          background: fastCardOpen ? 'var(--color-blue-light)' : 'transparent',
        }}
      >
        <StickyNote
          style={{ width: 14, height: 14 }}
          className={fastCardOpen ? 'text-[var(--color-blue)]' : 'text-[var(--text-light)]'}
          strokeWidth={2}
        />
        {fastCardItemCount > 0 && (
          <span
            className="absolute right-[-3px] top-[-3px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-[3px] text-[9px] font-semibold leading-none"
            style={{
              color: 'white',
              background: 'var(--color-blue)',
              boxShadow: '0 0 0 2px var(--surface-card-bg)',
            }}
          >
            {fastCardItemCount > 9 ? '9+' : fastCardItemCount}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={(event) => onShowUtilityMenu('downloads', event.currentTarget.getBoundingClientRect())}
        className={toolbarBtn}
        title="下载"
      >
        <Download style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
      </button>

      <button
        type="button"
        onClick={(event) => onShowUtilityMenu('more', event.currentTarget.getBoundingClientRect())}
        className={toolbarBtn}
        title="更多"
      >
        <MoreHorizontal style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
      </button>
    </div>
  )
}
