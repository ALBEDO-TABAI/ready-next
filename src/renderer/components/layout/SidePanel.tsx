import { AnimatePresence, motion, useIsPresent, usePresenceData, useReducedMotion } from 'framer-motion'
import { lazy, Suspense, useEffect, useMemo, useRef, type ComponentType, type ReactNode } from 'react'

import FilesPanel from './FilesPanel'
import { FILES_PANEL_DIMENSIONS } from './panelTokens'
import {
  WORKBENCH_PANEL_MOTION_DURATION_S,
  WORKBENCH_PANEL_MOTION_EASE,
  WORKBENCH_PANEL_MOTION_OFFSET_PX,
  WORKBENCH_PANEL_REDUCED_MOTION_DURATION_S,
} from '../../modules/workbench/panel-motion'
import type { GraphWorkspaceRequest } from '../graph/GraphWorkspace'

export type SidePanelVariant = 'files' | 'search' | 'skills' | 'backlinks' | 'graph' | 'hidden'

type RenderableSidePanelVariant = Exclude<SidePanelVariant, 'hidden'>

interface SidePanelProps {
  variant?: SidePanelVariant
  panelWidth: number
  contentVisible?: boolean
  /** docked: a column of the shell row; floating: a slide-out over the content (narrow windows, W2 §2.5). */
  presentation?: 'docked' | 'floating'
  floatingOpen?: boolean
  /** Left offset of the slide-out (the rail's width). */
  floatingInset?: number
  /** Opens the slide-out (hovering the window's left edge) and closes it (leaving the panel). */
  onFloatingPeek?: (open: boolean) => void
  onGraphWorkspaceOpen?: (request: GraphWorkspaceRequest) => void
  graphWorkspaceOpen?: boolean
}

interface AnimatedPanelSlots {
  header: ReactNode
  body: ReactNode
}

type DeferredPanelProps = {
  children: (slots: AnimatedPanelSlots) => ReactNode
}

type PanelDirection = -1 | 0 | 1

const GlobalSearchPanel = lazy(() => import('./GlobalSearchPanel')) as ComponentType<DeferredPanelProps>
const SkillsCenterPanel = lazy(() => import('./SkillsCenterPanel')) as ComponentType<DeferredPanelProps>
const BacklinksCenterPanel = lazy(() => import('./BacklinksCenterPanel')) as ComponentType<DeferredPanelProps>
const GraphCenterPanel = lazy(() => import('./GraphCenterPanel')) as ComponentType<DeferredPanelProps & {
  onOpenGlobal?: (request: GraphWorkspaceRequest) => void
  globalBrowseOpen?: boolean
}>

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
  presentation = 'docked',
  floatingOpen = false,
  floatingInset = 0,
  onFloatingPeek,
  onGraphWorkspaceOpen,
  graphWorkspaceOpen = false,
}: SidePanelProps) {
  const floating = presentation === 'floating'
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

  const renderDeferredPanel = (
    Panel: ComponentType<DeferredPanelProps>,
    panelKey: string,
  ) => (
    <Suspense key={panelKey} fallback={null}>
      <Panel>
        {(slots: AnimatedPanelSlots) => (
          <AnimatedPanelLayer
            direction={transitionDirection}
            reduceMotion={!!reduceMotion}
            header={slots.header}
            body={slots.body}
          />
        )}
      </Panel>
    </Suspense>
  )

  const renderAnimatedPanel = (targetVariant: RenderableSidePanelVariant) => {
    const panelKey = `side-panel-${targetVariant}`
    if (targetVariant === 'search') {
      return renderDeferredPanel(GlobalSearchPanel, panelKey)
    }

    if (targetVariant === 'skills') {
      return renderDeferredPanel(SkillsCenterPanel, panelKey)
    }

    if (targetVariant === 'backlinks') {
      return renderDeferredPanel(BacklinksCenterPanel, panelKey)
    }

    if (targetVariant === 'graph') {
      return (
        <Suspense key={panelKey} fallback={null}>
          <GraphCenterPanel onOpenGlobal={onGraphWorkspaceOpen} globalBrowseOpen={graphWorkspaceOpen}>
            {(slots: AnimatedPanelSlots) => (
              <AnimatedPanelLayer
                direction={transitionDirection}
                reduceMotion={!!reduceMotion}
                header={slots.header}
                body={slots.body}
              />
            )}
          </GraphCenterPanel>
        </Suspense>
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
    <>
    {floating && !floatingOpen && (
      <div className="shell-edge-reveal" style={{ left: floatingInset }} aria-hidden="true" onMouseEnter={() => onFloatingPeek?.(true)} />
    )}
    <div
      data-liquid-shell="side-panel"
      data-shell-sidebar="true"
      data-side-panel-variant={panelWidth > 0 ? variant : 'hidden'}
      data-side="left"
      data-open={floating ? String(floatingOpen) : undefined}
      // A slide-out over the browser makes the native web view step aside while it is open (W1 DL4).
      data-ready-native-overlay={floating && floatingOpen ? 'shell-sidebar' : undefined}
      className={`workbench-panel-frame flex-shrink-0 flex flex-col select-none overflow-hidden${floating ? ' shell-float-drawer' : ''}`}
      onMouseLeave={floating ? () => onFloatingPeek?.(false) : undefined}
      style={{
        width: panelWidth,
        minWidth: panelWidth,
        ...(floating ? { left: floatingInset } : { background: 'transparent', boxShadow: 'none' }),
        ...(panelWidth === 0 ? { borderWidth: 0 } : null),
        fontFamily: 'var(--rn-font-ui)',
      }}
    >
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
        <AnimatePresence initial={false} mode="wait" custom={contentVisible ? transitionDirection : 1}>
          {isVisible ? renderAnimatedPanel(variant as RenderableSidePanelVariant) : null}
        </AnimatePresence>
      </div>
    </div>
    </>
  )
}
