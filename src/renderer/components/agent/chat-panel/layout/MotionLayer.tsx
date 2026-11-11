import { useState } from 'react'
import { motion, useIsPresent, useReducedMotion } from 'framer-motion'
import { PanelLeftClose, History, Plus } from 'lucide-react'
import { IconButton } from '../../../ui/IconButton'
import {
  WORKBENCH_EDGE_RAIL_SIZE,
  WORKBENCH_TOPBAR_HEIGHT,
  WORKBENCH_TOPBAR_PADDING_RIGHT
} from '../../../../modules/workbench/chrome'
import {
  WORKBENCH_PANEL_MOTION_DURATION_S,
  WORKBENCH_PANEL_MOTION_EASE,
  WORKBENCH_PANEL_MOTION_OFFSET_PX,
  WORKBENCH_PANEL_REDUCED_MOTION_DURATION_S,
} from '../../../../modules/workbench/panel-motion'

// ---------------------------------------------------------------------------
// Stage V V1.3 — ChatPanel layout primitives extracted from ChatPanel.tsx.
// `ChatPanelMotionLayer` is the framer-motion wrapper that hosts the
// expanded/collapsing panel content (a collapsed assistant takes no width; the shell rail shows
// its button, W2 §2.4). It is a pure React component
// with zero `useAgent` / store / IPC dependencies — the only hooks are
// framer-motion's `useIsPresent` / `useReducedMotion`. Signatures are
// preserved byte-for-byte; the V6 fixture (`chat-panel-baseline.test.ts`)
// snapshot diff must stay at 0.
// ---------------------------------------------------------------------------

export function ChatPanelMotionLayer({
  header,
  body,
  children,
}: {
  header?: React.ReactNode
  body?: React.ReactNode
  children?: React.ReactNode
}) {
  const isPresent = useIsPresent()
  const layerZIndex = isPresent ? 1 : 2
  const reduceMotion = useReducedMotion()
  // will-change 只允许存在于动画进行期间（onAnimationStart → Complete）：
  // 它会强制 Chromium 为该层建立 backdrop root，把面板内 backdrop-filter
  // （聊天输入框的 LiquidLens 折射）能看到的背景整个掏空。静止时必须撤掉，
  // 动画时保留以避免逐帧重栅格化。
  const [isAnimating, setIsAnimating] = useState(false)
  const content = !header || !body
    ? children
    : (
        <div
          className="grid h-full min-h-0"
          style={{
            gridTemplateRows: `${WORKBENCH_TOPBAR_HEIGHT}px minmax(0, 1fr)`,
            gridTemplateColumns: 'minmax(0, 1fr)'
          }}
        >
          <div className="relative overflow-visible" style={{ zIndex: 4 }}>
            {header}
          </div>

          <div className="relative min-h-0 overflow-hidden flex flex-col" style={{ zIndex: 1 }}>
            {body}
          </div>
        </div>
      )

  return (
    <motion.div
      className="absolute inset-0 overflow-hidden"
      style={{
        zIndex: layerZIndex,
        pointerEvents: isPresent ? 'auto' : 'none',
        willChange: !reduceMotion && isAnimating ? 'transform, opacity' : 'auto'
      }}
      onAnimationStart={() => setIsAnimating(true)}
      onAnimationComplete={() => setIsAnimating(false)}
      initial={reduceMotion ? false : { x: WORKBENCH_PANEL_MOTION_OFFSET_PX, opacity: 0.01 }}
      animate={{
        x: 0,
        opacity: 1,
        transition: reduceMotion
          ? { duration: WORKBENCH_PANEL_REDUCED_MOTION_DURATION_S }
          : { duration: WORKBENCH_PANEL_MOTION_DURATION_S, ease: WORKBENCH_PANEL_MOTION_EASE }
      }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: { duration: WORKBENCH_PANEL_REDUCED_MOTION_DURATION_S } }
          : {
              x: WORKBENCH_PANEL_MOTION_OFFSET_PX,
              opacity: 0.01,
              transition: { duration: WORKBENCH_PANEL_MOTION_DURATION_S, ease: WORKBENCH_PANEL_MOTION_EASE }
            }
      }
    >
      {content}
    </motion.div>
  )
}
