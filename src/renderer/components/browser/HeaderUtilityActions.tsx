import {
  Bookmark,
  Download,
  MoreHorizontal,
} from 'lucide-react'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'

interface HeaderUtilityActionsProps {
  onShowUtilityMenu: (kind: BrowserUtilityMenuKind, anchorRect: DOMRect) => void
}

export default function HeaderUtilityActions({
  onShowUtilityMenu,
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
