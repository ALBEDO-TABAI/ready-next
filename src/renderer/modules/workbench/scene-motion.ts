import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { WORKBENCH_MODE_SCENE_TRANSITION_MS } from './mode-transition'

// A change of the shown scene (motion language M2–M3): the mode scenes in the content column and the navigators in the
// sidebar. The new one arrives (CSS transitions from an @starting-style, so the motion starts from where the eye is);
// every scene that is leaving keeps its own timer, so a quick second change never cuts a fade short or makes a scene
// jump. A scene that is called back while it leaves simply turns around from where it is.

export type SceneDirection = 'forward' | 'backward'

export interface SceneMotion<K extends string> {
  current: K
  /** The current scene is still arriving. */
  entering: boolean
  /** The way the last change went: forward is later in `order`. */
  direction: SceneDirection
  /** Scenes still leaving, each with the way it left. */
  leaving: Partial<Record<K, SceneDirection>>
}

/** How long a scene change keeps the leaving scenes on screen: the arrival time (--rn-d-2) and a little slack. */
export const SCENE_SETTLE_MS = WORKBENCH_MODE_SCENE_TRANSITION_MS + 40

export function useSceneMotion<K extends string>(current: K, options: { animate: boolean; order: readonly K[] }): SceneMotion<K> {
  const [state, setState] = useState<SceneMotion<K>>({ current, entering: false, direction: 'forward', leaving: {} })
  const shown = useRef(current)
  const animate = useRef(options.animate)
  animate.current = options.animate
  const order = useRef(options.order)
  order.current = options.order
  const tokens = useRef(new Map<K, number>())
  const timers = useRef(new Set<number>())
  const seq = useRef(0)

  // Before paint, so the old scene never vanishes for a frame.
  useLayoutEffect(() => {
    const from = shown.current
    if (from === current) return
    shown.current = current
    const direction: SceneDirection = order.current.indexOf(current) >= order.current.indexOf(from) ? 'forward' : 'backward'
    if (!animate.current) {
      tokens.current.clear()
      setState({ current, entering: false, direction, leaving: {} })
      return
    }
    const token = ++seq.current
    tokens.current.set(from, token)
    tokens.current.delete(current)
    setState(previous => {
      const leaving = { ...previous.leaving, [from]: direction }
      delete leaving[current]
      return { current, entering: true, direction, leaving }
    })
    const timer = window.setTimeout(() => {
      timers.current.delete(timer)
      // Decided here, not in the updater: React may run an updater twice (StrictMode), and it must stay pure.
      // Only the change that sent `from` away ends its leaving; a later change owns a later token.
      const ownsLeaving = tokens.current.get(from) === token
      if (ownsLeaving) tokens.current.delete(from)
      const latest = seq.current === token
      setState(previous => {
        const leaving = { ...previous.leaving }
        if (ownsLeaving) delete leaving[from]
        const entering = latest && previous.current === current ? false : previous.entering
        return { ...previous, leaving, entering }
      })
    }, SCENE_SETTLE_MS)
    timers.current.add(timer)
  }, [current])

  useEffect(() => {
    const pending = timers.current
    return () => { for (const timer of pending) window.clearTimeout(timer); pending.clear() }
  }, [])

  return state
}
