import {
  Bookmark,
  Download,
  MoreHorizontal,
  StickyNote,
} from 'lucide-react'
import type { BrowserUtilityMenuKind } from '../../../shared/browser-utility-menu'
import { IconButton } from '../ui'

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
  return (
    <div className="flex items-center flex-shrink-0" style={{ gap: 2 }}>
      <IconButton
        icon={<Bookmark />}
        onClick={(event) => onShowUtilityMenu('bookmarks', event.currentTarget.getBoundingClientRect())}
        title="收藏夹"
      />

      <IconButton
        icon={<>
          <StickyNote />
          {fastCardItemCount > 0 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-[-3px] top-[-3px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full px-[3px] text-[9px] font-semibold leading-none"
              style={{ color: 'var(--rn-on-inverse)', background: 'var(--rn-inverse)', fontFamily: 'var(--rn-font-mono)' }}
            >
              {fastCardItemCount > 9 ? '9+' : fastCardItemCount}
            </span>
          )}
        </>}
        onClick={onToggleFastCard}
        className="relative"
        title={fastCardItemCount > 0 ? `FastCard (${fastCardItemCount})` : 'FastCard'}
        aria-label={fastCardItemCount > 0 ? `FastCard，${fastCardItemCount} 条内容` : 'FastCard'}
        active={fastCardOpen}
      />

      <IconButton
        icon={<Download />}
        onClick={(event) => onShowUtilityMenu('downloads', event.currentTarget.getBoundingClientRect())}
        title="下载"
      />

      <IconButton
        icon={<MoreHorizontal />}
        onClick={(event) => onShowUtilityMenu('more', event.currentTarget.getBoundingClientRect())}
        title="更多"
      />
    </div>
  )
}
