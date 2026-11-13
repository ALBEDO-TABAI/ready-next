import ModeSlider from './ModeSlider'
import {
  WORKBENCH_TOPBAR_HEIGHT,
  WORKBENCH_TOPBAR_PADDING_LEFT,
  WORKBENCH_TOPBAR_PADDING_RIGHT,
} from '../../modules/workbench/chrome'
import { openToday } from '../../modules/today/open-today'

// The top band of the shell (W2 §2, W1 DL11a): a window drag region as tall as the bottom band.
// Left, 12px after the traffic lights: the wordmark (V12, V24), a label that drags the window like the rest of the band;
// its styles live in the shell's shell.css. The sidebar opens and closes from the rail's current mode icon and ⌘B (V23).
// The brand dot stays in the top-right corner (user, 2026-11-11) and opens 今日, the document
// mode's system tab (W6 §5).

export default function TopBar() {
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
        <span className="shell-wordmark">Ready</span>
      </div>
      <button type="button" className="flex items-center no-drag flex-shrink-0 bg-transparent border-0 p-0 cursor-pointer" aria-label="今日" title="今日" onClick={openToday}>
        <ModeSlider />
      </button>
    </div>
  )
}
