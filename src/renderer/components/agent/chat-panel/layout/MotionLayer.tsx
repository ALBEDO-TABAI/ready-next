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
// expanded/collapsing panel content; `CollapsedChatRail` is the right-edge
// rail shown when the panel is collapsed. Both are pure React components
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
  const content = !header || !body
    ? children
    : (
        <div
          className="grid h-full min-h-0"
          style={{
            gridTemplateRows: `${WORKBENCH_TOPBAR_HEIGHT}px minmax(0, 1fr)`
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
        willChange: reduceMotion ? 'auto' : 'transform, opacity'
      }}
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

export function CollapsedChatRail({
  onTogglePanel,
  onHistoryOpen,
  onNewSession
}: {
  onTogglePanel: () => void
  onHistoryOpen: () => void
  onNewSession: () => void
}) {
  return (
    <div
      className="flex h-full w-full flex-col"
      style={{
        width: WORKBENCH_EDGE_RAIL_SIZE,
        minWidth: WORKBENCH_EDGE_RAIL_SIZE,
        background: 'transparent',
        alignItems: 'flex-end',
        paddingRight: WORKBENCH_TOPBAR_PADDING_RIGHT,
        boxSizing: 'border-box'
      }}
    >
      <div
        className="flex w-full items-center justify-end"
        style={{
          height: WORKBENCH_TOPBAR_HEIGHT,
          borderBottom: '1px solid transparent'
        }}
      >
        <IconButton
          icon={<PanelLeftClose style={{ width: 15, height: 15 }} strokeWidth={2} />}
          onClick={onTogglePanel}
          title="展开聊天面板"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
        />
      </div>

      <div className="flex w-full flex-col items-end gap-2 pt-3">
        <IconButton
          icon={<History style={{ width: 14, height: 14 }} strokeWidth={2} />}
          onClick={onHistoryOpen}
          title="打开历史对话"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
        />
        <IconButton
          icon={<Plus style={{ width: 14, height: 14 }} strokeWidth={2} />}
          onClick={onNewSession}
          title="新建对话"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
        />
      </div>
    </div>
  )
}
