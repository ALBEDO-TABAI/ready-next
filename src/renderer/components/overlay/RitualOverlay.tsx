import { useEffect, useRef } from 'react'
import { useRitualOverlayStore } from '../../modules/overlay/useRitualOverlay'
import { beginBrowserMask, endBrowserMask } from '../../modules/overlay/browserViewMask'
import ThemeRitualChoreography from './ThemeRitualChoreography'

export function RitualOverlay() {
  const session = useRitualOverlayStore((state) => state.session)
  const lastStageRef = useRef<string | null>(null)
  const maskActiveRef = useRef(false)

  useEffect(() => {
    if (!session) {
      if (maskActiveRef.current) {
        void endBrowserMask()
        maskActiveRef.current = false
      }
      lastStageRef.current = null
      return
    }

    if (session.phase === 'entering' || session.phase === 'holding') {
      if (!maskActiveRef.current) {
        beginBrowserMask()
        maskActiveRef.current = true
      }
    }
    if (session.phase === 'leaving' && maskActiveRef.current) {
      void endBrowserMask()
      maskActiveRef.current = false
    }
    lastStageRef.current = session.stage
  }, [session])

  useEffect(() => () => {
    if (maskActiveRef.current) {
      void endBrowserMask()
      maskActiveRef.current = false
    }
  }, [])

  if (!session) return null

  const enterMs = session.timeline.enterDurationMs
  const leaveMs = session.timeline.leaveDurationMs

  return (
    <div
      data-ritual-overlay=""
      data-stage={session.stage}
      data-phase={session.phase}
      data-direction={session.meta.direction ?? undefined}
      aria-hidden="true"
      style={{
        ['--ritual-enter-duration' as string]: `${enterMs}ms`,
        ['--ritual-leave-duration' as string]: `${leaveMs}ms`,
      }}
    >
      {session.stage === 'theme-transition' ? <ThemeRitualChoreography /> : null}
    </div>
  )
}

export default RitualOverlay
