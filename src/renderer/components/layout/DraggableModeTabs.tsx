import type { ElementType, MouseEvent as ReactMouseEvent } from 'react'
import { Globe, FileText, Rss, Calendar } from 'lucide-react'
import type { WorkbenchMode } from '../../stores/useMode'
import { useTheme } from '../../stores/useTheme'
import { CalendarFilled, FileTextFilled, GlobeFilled } from '../../design/next/icons'
import { LiquidLens } from '../ui/liquid-glass/LiquidLens'
import { LiquidBackdropProjection } from '../ui/liquid-glass/LiquidBackdropProjection'
import { WORKBENCH_MODE_ORDER } from '../../modules/workbench/mode-split'

// The mode switch slot above the assistant composer (V20, V21, V32): the four modes on a liquid-glass pill, the same
// glass as the composer and the project chip beside it. Nothing slides on it: the current mode's icon is lit (both
// modes of a split), the others rest. Each icon has a resting twin (outline, quiet ink) and a lit twin (the filled
// glyph, or 资讯's outline at a heavier stroke, white with a soft glow), crossfaded in mode-switch.css. It shows the
// rail's state and switches through the rail's handlers (WorkbenchMode). The file and class names date from the
// dragged thumb it once had.
const MODE_TABS: Record<WorkbenchMode, { label: string; hint: string; icon: ElementType; activeIcon?: ElementType }> = {
  browser: { label: '浏览器', hint: '⌘1', icon: Globe, activeIcon: GlobeFilled },
  document: { label: '文档', hint: '⌘2', icon: FileText, activeIcon: FileTextFilled },
  rss: { label: '资讯', hint: '⌘3', icon: Rss },
  calendar: { label: '日历', hint: '⌘4', icon: Calendar, activeIcon: CalendarFilled },
}

const SLOT_RADIUS = 20

interface DraggableModeTabsProps {
  activeMode: WorkbenchMode
  splitMode?: WorkbenchMode | null
  onChange: (mode: WorkbenchMode) => void
  /** ⇧-click (or ⌥-click, as on the rail) opens the mode beside the current one. */
  onSplitToggle?: (mode: WorkbenchMode) => void
}

export default function DraggableModeTabs({
  activeMode,
  splitMode = null,
  onChange,
  onSplitToggle,
}: DraggableModeTabsProps) {
  // 减少透明（DL12）：no refraction or projection, the glass falls back to the panel colour (liquid-composer.css).
  const lensEngine = useTheme(state => state.transparency === 'reduced') ? 'off' : 'backdrop'
  const isSplit = splitMode !== null && splitMode !== activeMode

  const handleClick = (mode: WorkbenchMode, e: ReactMouseEvent) => {
    e.stopPropagation()
    if ((e.shiftKey || e.altKey) && onSplitToggle) {
      onSplitToggle(mode)
      return
    }
    onChange(mode)
  }

  return (
    <div
      className="draggable-mode-tabs"
      role="tablist"
      aria-label="模式"
      aria-multiselectable={isSplit}
    >
      <LiquidLens
        className="draggable-mode-tabs__surface"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        radius={SLOT_RADIUS}
        bevel={8}
        depth={18.5}
        ior={1.34}
        dome={0.65}
        profile="squircle"
        strength={2.4}
        blur={3.5}
        frost={0}
        blurBeforeRefraction
        saturation={1.18}
        brightness={1.05}
        contrast={0.84}
        aberration={0}
        engine={lensEngine}
        backdropContent={(
          <LiquidBackdropProjection
            className="draggable-mode-tabs__projection"
            sourceMaskRadius={SLOT_RADIUS}
          />
        )}
      />

      {WORKBENCH_MODE_ORDER.map((mode) => {
        const { label, hint, icon: Icon, activeIcon: ActiveIcon } = MODE_TABS[mode]
        return (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={mode === activeMode || mode === splitMode}
            aria-label={label}
            title={`${label} ${hint}`}
            className="draggable-mode-tabs__icon"
            data-mode={mode}
            onClick={(e) => handleClick(mode, e)}
          >
            <span className="draggable-mode-tabs__glyphs">
              <Icon className="draggable-mode-tabs__glyph is-rest" strokeWidth={1.5} aria-hidden="true" />
              {ActiveIcon
                ? <ActiveIcon className="draggable-mode-tabs__glyph is-lit" strokeWidth={1.5} aria-hidden="true" />
                : <Icon className="draggable-mode-tabs__glyph is-lit" strokeWidth={2} aria-hidden="true" />}
            </span>
          </button>
        )
      })}
    </div>
  )
}
