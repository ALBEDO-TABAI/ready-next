import { useEffect, useRef } from 'react'
import { useRitualOverlayStore } from '../../modules/overlay/useRitualOverlay'
import { beginBrowserMask, endBrowserMask } from '../../modules/overlay/browserViewMask'
import ThemeRitualChoreography from './ThemeRitualChoreography'

export function RitualOverlay() {
  const session = useRitualOverlayStore((state) => state.session)
  const maskActiveRef = useRef(false)

  useEffect(() => {
    if (!session) {
      if (maskActiveRef.current) {
        void endBrowserMask()
        maskActiveRef.current = false
      }
      document.documentElement.removeAttribute('data-mode-switching')
      document.documentElement.removeAttribute('data-theme-ritual-phase')
      document.documentElement.removeAttribute('data-theme-ritual-direction')
      document.documentElement.style.removeProperty('--ritual-hold-duration')
      document.documentElement.style.removeProperty('--ritual-leave-duration')
      return
    }

    const shouldKeepMaskUntilSessionEnd = session.stage === 'theme-transition'
    const shouldActivateMask =
      session.phase === 'entering'
      || session.phase === 'holding'
      || (shouldKeepMaskUntilSessionEnd && session.phase === 'leaving')
    if (shouldActivateMask) {
      if (!maskActiveRef.current) {
        beginBrowserMask()
        maskActiveRef.current = true
      }
    }
    const shouldReleaseMaskDuringLeaving = session.stage === 'mode-switch' && session.phase === 'leaving'
    if (shouldReleaseMaskDuringLeaving && maskActiveRef.current) {
      void endBrowserMask()
      maskActiveRef.current = false
    }

    const inModeSwitch =
      session.stage === 'mode-switch' &&
      (session.phase === 'entering' || session.phase === 'holding' || session.phase === 'leaving')
    if (inModeSwitch) {
      document.documentElement.setAttribute('data-mode-switching', 'true')
    } else {
      document.documentElement.removeAttribute('data-mode-switching')
    }

    // Drive the renderer-owned ritual base + content fade layers off the theme-transition
    // phase and direction. CSS in ritual-overlay.css keys off these attributes.
    if (session.stage === 'theme-transition') {
      document.documentElement.setAttribute('data-theme-ritual-phase', session.phase)
      document.documentElement.style.setProperty('--ritual-hold-duration', `${session.timeline.holdingMinDurationMs}ms`)
      document.documentElement.style.setProperty('--ritual-leave-duration', `${session.timeline.leaveDurationMs}ms`)
      if (session.meta.direction) {
        document.documentElement.setAttribute('data-theme-ritual-direction', session.meta.direction)
      } else {
        document.documentElement.removeAttribute('data-theme-ritual-direction')
      }
    } else {
      document.documentElement.removeAttribute('data-theme-ritual-phase')
      document.documentElement.removeAttribute('data-theme-ritual-direction')
      document.documentElement.style.removeProperty('--ritual-hold-duration')
      document.documentElement.style.removeProperty('--ritual-leave-duration')
    }
  }, [session])

  useEffect(() => () => {
    if (maskActiveRef.current) {
      void endBrowserMask()
      maskActiveRef.current = false
    }
  }, [])

  if (!session) return null

  return (
    <div
      data-ritual-overlay=""
      data-stage={session.stage}
      data-phase={session.phase}
      data-direction={session.meta.direction ?? undefined}
      aria-hidden="true"
      style={{
        ['--ritual-enter-duration' as string]: `${session.timeline.enterDurationMs}ms`,
        ['--ritual-leave-duration' as string]: `${session.timeline.leaveDurationMs}ms`,
        ['--ritual-hold-duration' as string]: `${session.timeline.holdingMinDurationMs}ms`,
      }}
    >
      {session.stage === 'theme-transition' ? <ThemeRitualChoreography /> : null}
    </div>
  )
}

export default RitualOverlay
