import { AnimatePresence, motion, useIsPresent, usePresenceData, useReducedMotion } from 'framer-motion'
import { useEffect, useMemo, useRef, type ReactNode } from 'react'

import { useWorkspace } from '../../stores/useWorkspace'
import FilesPanel from './FilesPanel'
import GlobalSearchPanel from './GlobalSearchPanel'
import SkillsCenterPanel from './SkillsCenterPanel'
import { FILES_PANEL_DIMENSIONS } from './panelTokens'

export type SidePanelVariant = 'files' | 'search' | 'skills' | 'hidden'

type RenderableSidePanelVariant = Exclude<SidePanelVariant, 'hidden'>

interface SidePanelProps {
  variant?: SidePanelVariant
}

interface AnimatedPanelSlots {
  header: ReactNode
  body: ReactNode
}

type PanelDirection = -1 | 0 | 1

const STREAM_EASE = [0.22, 1, 0.36, 1] as const
const PANEL_STACK_ORDER: Record<RenderableSidePanelVariant, number> = {
  files: 0,
  search: 1,
  skills: 2,
}
const HEADER_STREAM_DURATION = 0.32
const CONTENT_STREAM_DURATION = 0.4
const REDUCED_STREAM_DURATION = 0.12

function AnimatedPanelLayer({
  body,
  header,
  panelKey,
  panelWidth,
  direction,
  reduceMotion,
}: AnimatedPanelSlots & { panelKey: string; panelWidth: number; direction: PanelDirection; reduceMotion: boolean }) {
  const isPresent = useIsPresent()
  const presenceDirection = usePresenceData() as PanelDirection | undefined
  const resolvedDirection = ((presenceDirection ?? direction) as PanelDirection) || 1
  const layerZIndex = isPresent ? 1 : 2

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{
        zIndex: layerZIndex,
        pointerEvents: isPresent ? 'auto' : 'none',
        width: panelWidth,
        minWidth: panelWidth,
      }}
    >
      <div
        className="grid h-full min-h-0"
        style={{
          gridTemplateRows: `${FILES_PANEL_DIMENSIONS.headerHeight}px minmax(0, 1fr)`,
        }}
      >
        <div className="relative overflow-hidden">
          <motion.div
            key={`${panelKey}-header`}
            custom={resolvedDirection}
            className="absolute inset-0"
            style={{
              willChange: 'transform',
              backfaceVisibility: 'hidden',
              transform: 'translateZ(0)',
            }}
            initial={reduceMotion ? false : { y: resolvedDirection > 0 ? '72%' : '-72%' }}
            animate={{
              y: 0,
              transition: reduceMotion
                ? { duration: REDUCED_STREAM_DURATION }
                : { duration: HEADER_STREAM_DURATION, ease: STREAM_EASE },
            }}
            exit={
              reduceMotion
                ? undefined
                : {
                    y: resolvedDirection > 0 ? '-72%' : '72%',
                    transition: { duration: HEADER_STREAM_DURATION, ease: STREAM_EASE },
                  }
            }
          >
            {header}
          </motion.div>
        </div>

        <div className="relative min-h-0 overflow-hidden">
          <motion.div
            key={`${panelKey}-body`}
            custom={resolvedDirection}
            className="absolute inset-0 flex min-h-0 flex-col"
            style={{
              willChange: 'transform',
              backfaceVisibility: 'hidden',
              transform: 'translateZ(0)',
            }}
            initial={reduceMotion ? false : { y: resolvedDirection > 0 ? '100%' : '-100%' }}
            animate={{
              y: 0,
              transition: reduceMotion
                ? { duration: REDUCED_STREAM_DURATION }
                : { duration: CONTENT_STREAM_DURATION, ease: STREAM_EASE },
            }}
            exit={
              reduceMotion
                ? undefined
                : {
                    y: resolvedDirection > 0 ? '-100%' : '100%',
                    transition: { duration: CONTENT_STREAM_DURATION, ease: STREAM_EASE },
                  }
            }
          >
            {body}
          </motion.div>
        </div>
      </div>
    </div>
  )
}

export default function SidePanel({ variant = 'files' }: SidePanelProps) {
  const sidebarVisible = useWorkspace((state) => state.sidebarVisible)
  const sidePanelWidths = useWorkspace((state) => state.sidePanelWidths)
  const reduceMotion = useReducedMotion()
  const lastVisibleVariantRef = useRef<RenderableSidePanelVariant>('files')

  const isVisible = variant !== 'hidden' && sidebarVisible
  const panelWidth = sidePanelWidths.shared
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
              panelKey={panelKey}
              panelWidth={panelWidth}
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
              panelKey={panelKey}
              panelWidth={panelWidth}
              direction={transitionDirection}
              reduceMotion={!!reduceMotion}
              header={slots.header}
              body={slots.body}
            />
          )}
        </SkillsCenterPanel>
      )
    }

    return (
      <FilesPanel key={panelKey} isVisible={isVisible}>
        {(slots) => (
          <AnimatedPanelLayer
            panelKey={panelKey}
            panelWidth={panelWidth}
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
      data-side-panel-variant={isVisible ? variant : 'hidden'}
      className="workbench-panel-frame flex-shrink-0 flex flex-col select-none overflow-hidden"
      style={{
        width: isVisible ? panelWidth : 0,
        minWidth: isVisible ? panelWidth : 0,
        background: 'transparent',
        boxShadow: 'none',
        fontFamily: 'Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        transition: 'width 300ms ease-in-out, min-width 300ms ease-in-out',
      }}
    >
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
        <AnimatePresence initial={false} mode="sync" custom={sidebarVisible ? transitionDirection : 1}>
          {isVisible ? renderAnimatedPanel(variant as RenderableSidePanelVariant) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}
