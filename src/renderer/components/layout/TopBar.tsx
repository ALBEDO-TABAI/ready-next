import { PanelLeft } from 'lucide-react'
import ModeSlider from './ModeSlider'
import { IconButton } from '../ui/Button'
import {
  WORKBENCH_TOPBAR_HEIGHT,
  WORKBENCH_TOPBAR_PADDING_LEFT,
  WORKBENCH_TOPBAR_PADDING_RIGHT,
} from '../../modules/workbench/chrome'
import { openToday } from '../../modules/today/open-today'

// The top band of the shell (W2 §2, W1 DL11a): a window drag region as tall as the bottom band.
// Left, after the traffic lights: the sidebar's one switch (V13; the same as ⌘B and the current rail icon), then the
// wordmark (V12), a label that drags the window like the rest of the band. Its styles live in the shell's shell.css.
// The brand dot stays in the top-right corner (user, 2026-11-11) and opens 今日, the document
// mode's system tab (W6 §5).

export default function TopBar({ sidebarShown, onSidebarToggle }: {
  /** Docked, or its card open on a narrow window. */
  sidebarShown: boolean
  onSidebarToggle: () => void
}) {
  return (
    <div
      data-liquid-shell="topbar"
      data-shell-band="top"
      className="flex items-center justify-between drag-region"
      style={{
        background: 'transparent',
        height: WORKBENCH_TOPBAR_HEIGHT,
        paddingLeft: WORKBENCH_TOPBAR_PADDING_LEFT,
        paddingRight: WORKBENCH_TOPBAR_PADDING_RIGHT,
        boxShadow: 'none',
      }}
    >
      <div className="shell-band-lead">
        <IconButton
          className="no-drag"
          data-shell-sidebar-control=""
          icon={<PanelLeft aria-hidden="true" />}
          title={`${sidebarShown ? '收起侧栏' : '展开侧栏'} ⌘B`}
          aria-expanded={sidebarShown}
          onClick={onSidebarToggle}
        />
        <span className="shell-wordmark">Ready</span>
      </div>
      <button type="button" className="flex items-center no-drag flex-shrink-0 bg-transparent border-0 p-0 cursor-pointer" aria-label="今日" title="今日" onClick={openToday}>
        <ModeSlider />
      </button>
    </div>
  )
}
