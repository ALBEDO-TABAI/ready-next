import { ArrowLeft, ArrowRight } from 'lucide-react'
import { appShortcut, shortcutKeycaps } from '../../../shared/app-shortcuts'
import { useMode, type WorkbenchMode } from '../../stores/useMode'
import { useNavigationHistory } from './navigation-history'
import { useShellFocusedMode } from './shell/sidebar-slot'

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform)
const keys = (id: string) => shortcutKeycaps(appShortcut(id), mac).join(mac ? '' : '+')
const report = (error: unknown) => console.error('[navigation] could not go there', error)

/**
 * The way back (W6 §4): one entry at the top-left of the content area in every mode, before the paper's breadcrumb,
 * naming where it goes — “← 新书发布”. A quiet → follows once there is somewhere to go forward to. ⌘[ and ⌘] move the
 * same history, so the entry always says what the shortcut would do. In split view it sits in the pane being used.
 */
export function NavigationBackEntry({ mode }: { mode: WorkbenchMode }) {
  const { canBack, canForward, backTitle, forwardTitle, back, forward } = useNavigationHistory()
  const split = useMode(state => state.splitMode)
  const focused = useShellFocusedMode()
  if ((split && focused !== mode) || (!canBack && !canForward)) return null
  return <nav className="rn-back" aria-label="返回" data-navigation-back={mode}>
    {canBack && <button type="button" className="rn-back__button" aria-label={`返回 ${backTitle}`} title={`回到「${backTitle}」 ${keys('navigate-back')}`}
      onClick={() => { void back().catch(report) }}>
      <ArrowLeft aria-hidden size={14} strokeWidth={1.75} /><span className="rn-back__title">{backTitle}</span>
    </button>}
    {canForward && <button type="button" className="rn-back__button rn-back__forward" aria-label={`前进到 ${forwardTitle}`} title={`前进到「${forwardTitle}」 ${keys('navigate-forward')}`}
      onClick={() => { void forward().catch(report) }}>
      <ArrowRight aria-hidden size={14} strokeWidth={1.75} />
    </button>}
  </nav>
}
