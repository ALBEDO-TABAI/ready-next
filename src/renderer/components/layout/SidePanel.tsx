import { AnimatePresence, motion, useIsPresent, usePresenceData, useReducedMotion } from 'framer-motion'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'

import FilesPanel from './FilesPanel'
import GlobalSearchPanel from './GlobalSearchPanel'
import SkillsCenterPanel from './SkillsCenterPanel'
import BacklinksCenterPanel from './BacklinksCenterPanel'
import GraphCenterPanel from './GraphCenterPanel'
import { FILES_PANEL_DIMENSIONS } from './panelTokens'
import {
  WORKBENCH_PANEL_MOTION_DURATION_S,
  WORKBENCH_PANEL_MOTION_EASE,
  WORKBENCH_PANEL_MOTION_OFFSET_PX,
  WORKBENCH_PANEL_REDUCED_MOTION_DURATION_S,
} from '../../modules/workbench/panel-motion'

export type SidePanelVariant = 'files' | 'search' | 'skills' | 'backlinks' | 'graph' | 'hidden'

type RenderableSidePanelVariant = Exclude<SidePanelVariant, 'hidden'>

interface SidePanelProps {
  variant?: SidePanelVariant
  panelWidth: number
  contentVisible?: boolean
}

interface AnimatedPanelSlots {
  header: ReactNode
  body: ReactNode
}

type PanelDirection = -1 | 0 | 1

const PANEL_STACK_ORDER: Record<RenderableSidePanelVariant, number> = {
  files: 0,
  search: 1,
  skills: 2,
  backlinks: 3,
  graph: 4,
}

function AnimatedPanelLayer({
  body,
  header,
  direction,
  reduceMotion,
}: AnimatedPanelSlots & { direction: PanelDirection; reduceMotion: boolean }) {
  const isPresent = useIsPresent()
  const presenceDirection = usePresenceData() as PanelDirection | undefined
  const resolvedDirection = ((presenceDirection ?? direction) as PanelDirection) || 1
  const layerZIndex = isPresent ? 1 : 2

  return (
    <motion.div
      className="absolute inset-0 overflow-hidden"
      custom={resolvedDirection}
      style={{
        zIndex: layerZIndex,
        pointerEvents: isPresent ? 'auto' : 'none',
        willChange: reduceMotion ? 'auto' : 'transform, opacity',
      }}
      initial={reduceMotion ? false : { x: resolvedDirection > 0 ? WORKBENCH_PANEL_MOTION_OFFSET_PX : -WORKBENCH_PANEL_MOTION_OFFSET_PX, opacity: 0.01 }}
      animate={{
        x: 0,
        opacity: 1,
        transition: reduceMotion
          ? { duration: WORKBENCH_PANEL_REDUCED_MOTION_DURATION_S }
          : { duration: WORKBENCH_PANEL_MOTION_DURATION_S, ease: WORKBENCH_PANEL_MOTION_EASE },
      }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: { duration: WORKBENCH_PANEL_REDUCED_MOTION_DURATION_S } }
          : {
              x: resolvedDirection > 0 ? -WORKBENCH_PANEL_MOTION_OFFSET_PX : WORKBENCH_PANEL_MOTION_OFFSET_PX,
              opacity: 0.01,
              transition: { duration: WORKBENCH_PANEL_MOTION_DURATION_S, ease: WORKBENCH_PANEL_MOTION_EASE },
            }
      }
    >
      <div
        className="grid h-full min-h-0"
        style={{
          gridTemplateRows: `${FILES_PANEL_DIMENSIONS.headerHeight}px minmax(0, 1fr)`,
        }}
      >
        <div className="relative overflow-hidden">
          {header}
        </div>

        <div className="relative min-h-0 overflow-hidden flex flex-col">
          {body}
        </div>
      </div>
    </motion.div>
  )
}

export default function SidePanel({
  variant = 'files',
  panelWidth,
  contentVisible = true,
}: SidePanelProps) {
  const reduceMotion = useReducedMotion()
  const lastVisibleVariantRef = useRef<RenderableSidePanelVariant>('files')

  const isVisible = variant !== 'hidden' && contentVisible
  const transitionDirection = useMemo<PanelDirection>(() => {
    if (!isVisible) return 0
    if (lastVisibleVariantRef.current === variant) return 0
    const delta = PANEL_STACK_ORDER[variant] - PANEL_STACK_ORDER[lastVisibleVariantRef.current]
    return delta > 0 ? 1 : -1
  }, [isVisible, variant])

  useEffect(() => {
    if (!isVisible) return
    lastVisibleVariantRef.current = variant
  }, [isVisible, variant])

  const renderAnimatedPanel = (targetVariant: RenderableSidePanelVariant) => {
    const panelKey = `side-panel-${targetVariant}`
    if (targetVariant === 'search') {
      return (
        <GlobalSearchPanel key={panelKey}>
          {(slots) => (
            <AnimatedPanelLayer
              direction={transitionDirection}
              reduceMotion={!!reduceMotion}
              header={slots.header}
              body={slots.body}
            />
          )}
        </GlobalSearchPanel>
      )
    }

    if (targetVariant === 'skills') {
      return (
        <SkillsCenterPanel key={panelKey}>
          {(slots) => (
            <AnimatedPanelLayer
              direction={transitionDirection}
              reduceMotion={!!reduceMotion}
              header={slots.header}
              body={slots.body}
            />
          )}
        </SkillsCenterPanel>
      )
    }

    if (targetVariant === 'backlinks') {
      return (
        <BacklinksCenterPanel key={panelKey}>
          {(slots) => (
            <AnimatedPanelLayer
              direction={transitionDirection}
              reduceMotion={!!reduceMotion}
              header={slots.header}
              body={slots.body}
            />
          )}
        </BacklinksCenterPanel>
      )
    }

    if (targetVariant === 'graph') {
      return (
        <GraphCenterPanel key={panelKey}>
          {(slots) => (
            <AnimatedPanelLayer
              direction={transitionDirection}
              reduceMotion={!!reduceMotion}
              header={slots.header}
              body={slots.body}
            />
          )}
        </GraphCenterPanel>
      )
    }

    return (
      <FilesPanel key={panelKey} isVisible={isVisible}>
        {(slots) => (
          <AnimatedPanelLayer
            direction={transitionDirection}
            reduceMotion={!!reduceMotion}
            header={slots.header}
            body={slots.body}
          />
        )}
      </FilesPanel>
    )
  }

  return (
    <div
      data-liquid-shell="side-panel"
      data-side-panel-variant={panelWidth > 0 ? variant : 'hidden'}
      className="workbench-panel-frame flex-shrink-0 flex flex-col select-none overflow-hidden"
      style={{
        width: panelWidth,
        minWidth: panelWidth,
        background: 'transparent',
        boxShadow: 'none',
        fontFamily: 'Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      }}
    >
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
        <AnimatePresence initial={false} mode="wait" custom={contentVisible ? transitionDirection : 1}>
          {isVisible ? renderAnimatedPanel(variant as RenderableSidePanelVariant) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}
