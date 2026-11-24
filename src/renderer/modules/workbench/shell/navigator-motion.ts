import type { WorkbenchMode } from '../../../stores/useMode'
import { useSceneMotion, type SceneMotion } from '../scene-motion'

/** The rail's order of the modes (ShellRail), top to bottom. */
export const SHELL_RAIL_ORDER: readonly WorkbenchMode[] = ['browser', 'document', 'rss', 'calendar']

/** The navigators' change in progress (V23): the shown one, whether it is still arriving, and those still leaving. */
export type ShellNavigatorMotion = SceneMotion<WorkbenchMode>

/**
 * Moves the sidebar's navigators vertically when the shown mode changes, in step with the content's scenes and on the
 * same timing (scene-motion.ts): the new one rises or drops in, each old one stays on screen, inert, until it has left.
 * With `animate` off (an immediate mode change, a collapsed sidebar) the change is instant.
 */
export function useNavigatorMotion(mode: WorkbenchMode, animate: boolean): ShellNavigatorMotion {
  return useSceneMotion(mode, { animate, order: SHELL_RAIL_ORDER })
}

/** forward in the rail is down the column. */
export const navigatorDirection = (direction: SceneMotion<WorkbenchMode>['direction']) => direction === 'forward' ? 'down' : 'up'
