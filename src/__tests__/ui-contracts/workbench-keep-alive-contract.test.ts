import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench outlet keeps all modes mounted and routes mode switching through the ritual overlay', () => {
  const outlet = readWorkspaceFile('src/renderer/components/layout/WorkbenchModeOutlet.tsx')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const keyboardShortcuts = readWorkspaceFile('src/renderer/hooks/useKeyboardShortcuts.ts')
  const modeTransition = readWorkspaceFile('src/renderer/modules/workbench/mode-transition.ts')

  assert.match(outlet, /const ALL_WORKBENCH_MODES: WorkbenchMode\[\] = \['browser', 'document', 'rss', 'calendar'\]/)
  assert.match(outlet, /const ALL_MODE_LOADERS = \[loadBrowserMode, loadDocumentMode, loadRSSMode, loadCalendarMode\]/)
  assert.match(outlet, /let hasPreloadedWorkbenchModes = false/)
  assert.match(outlet, /useEffect\(\(\) => \{[\s\S]*if \(hasPreloadedWorkbenchModes\) return[\s\S]*ALL_MODE_LOADERS\.forEach\(\(loadMode\) => \{[\s\S]*void loadMode\(\)/)
  assert.match(outlet, /const ModeScene = memo\(function ModeScene/)
  assert.match(outlet, /display: isActive \? 'block' : 'none'/)
  assert.match(outlet, /pointerEvents: isActive \? 'auto' : 'none'/)
  assert.match(outlet, /transform: 'translate3d\(0, 0, 0\)'/)
  assert.match(outlet, /aria-hidden=\{!isActive\}/)
  assert.match(outlet, /isActive=\{modeKey === mode\}/)
  assert.match(outlet, /isMotionSettled=\{isActive \? isMotionSettled : false\}/)
  assert.doesNotMatch(outlet, /MODE_SCENE_TRANSITION/)
  assert.doesNotMatch(outlet, /MODE_LEAVING_OFFSET_PERCENT/)
  assert.doesNotMatch(outlet, /MODE_LEAVING_FADE_OPACITY/)
  assert.doesNotMatch(outlet, /resolveModeDirection/)
  assert.doesNotMatch(outlet, /leavingMode/)
  assert.doesNotMatch(outlet, /allowEarlyHostReveal/)
  assert.doesNotMatch(outlet, /motion\.div/)
  assert.doesNotMatch(outlet, /contentVisibility:/)

  assert.match(topBar, /onWorkbenchModeChange\?: \(mode: WorkbenchMode\) => void \| Promise<void>/)
  assert.match(topBar, /if \(onWorkbenchModeChange\) \{[\s\S]*void onWorkbenchModeChange\(mode\)/)

  assert.match(workbenchMode, /import \{ withRitual \} from '\.\.\/modules\/overlay\/useRitualOverlay'/)
  assert.match(workbenchMode, /const \[isMotionSettled, setIsMotionSettled\] = useState\(true\)/)
  assert.match(workbenchMode, /const transitionTargetModeRef = useRef<WorkbenchMode(?:Type)>\(workbenchMode\)/)
  assert.match(workbenchMode, /const handleWorkbenchModeChange = useCallback\(async function handleWorkbenchModeChange/)
  assert.match(workbenchMode, /if \(nextMode === workbenchMode\) return/)
  assert.match(workbenchMode, /if \(splitMode\) \{[\s\S]*setWorkbenchMode\(nextMode\)[\s\S]*return/)
  assert.match(workbenchMode, /await withRitual\('mode-switch', \(\{ signalReady \}\) => \{[\s\S]*setWorkbenchMode\(nextMode\)[\s\S]*signalReady\(\)/)
  assert.match(workbenchMode, /setIsMotionSettled\(false\)/)
  assert.match(workbenchMode, /setIsMotionSettled\(true\)/)
  assert.doesNotMatch(workbenchMode, /const MODE_TRANSITION_DURATION_MS = 350/)
  assert.doesNotMatch(workbenchMode, /const transitionTimerRef = useRef/)
  assert.doesNotMatch(workbenchMode, /transitionTimerRef\.current = window\.setTimeout/)
  assert.match(workbenchMode, /READY_WORKBENCH_MODE_CHANGE_EVENT/)
  assert.match(workbenchMode, /window\.addEventListener\(READY_WORKBENCH_MODE_CHANGE_EVENT, handleExternalWorkbenchModeChange as EventListener\)/)
  assert.match(workbenchMode, /<WorkbenchModeOutlet[\s\S]*mode=\{workbenchMode\}[\s\S]*isMotionSettled=\{isMotionSettled\}[\s\S]*browserLayoutPhase=\{browserLayoutPhase\}[\s\S]*\/>/)
  assert.match(modeTransition, /export const READY_WORKBENCH_MODE_CHANGE_EVENT = 'ready:workbench-mode-change-request'/)
  assert.match(modeTransition, /requestWorkbenchModeChange/)
  assert.match(keyboardShortcuts, /requestWorkbenchModeChange\(mode\)/)
  assert.match(keyboardShortcuts, /if \(appMode === 'workbench'\)/)
})

test('workbench shell hides all browser hosts on unmount (show/hide during mode change is now consolidated inside useBrowserViewBounds)', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  // Mode-change hide/show is now driven by the isActive/isVisibleAllowed reactive effect inside useBrowserViewBounds,
  // so WorkbenchMode no longer needs the visibleModes effect.
  assert.doesNotMatch(workbenchMode, /const visibleModes = \[workbenchMode, splitMode\]\.filter\(Boolean\)/)
  assert.doesNotMatch(workbenchMode, /if \(!visibleModes\.includes\('browser'\)\) \{[\s\S]*void window\.electronAPI\?\.browser\.hideAll\(\)/)
  // Stage X4 PR-shell-1 — Unmount cleanup emits the `hide-all`
  // BrowserViewIntent (reason = `mode-switch-prepare`) in place of the
  // legacy direct `browser.hideAll()` call. This stays the last-resort
  // guard against stale native overlays.
  assert.match(
    workbenchMode,
    /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*sendIntent\(\{[\s\S]*kind: 'hide-all'[\s\S]*reason: 'mode-switch-prepare'/,
  )
  assert.doesNotMatch(workbenchMode, /browser\.hideAll\(\)/)
  assert.doesNotMatch(workbenchMode, /browser\.hideActiveHost\(\)/)
})

test('rss and calendar modes gate heavyweight work behind foreground activity when kept alive', () => {
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const previewBrowser = readWorkspaceFile('src/renderer/components/rss/PreviewBrowser.tsx')

  assert.match(rssMode, /interface RSSModeProps \{[\s\S]*isActive\?: boolean[\s\S]*isMotionSettled\?: boolean[\s\S]*\}/)
  assert.match(rssMode, /export default function RSSMode\(\{[\s\S]*isActive = true,[\s\S]*isMotionSettled = true,[\s\S]*\}: RSSModeProps\)/)
  assert.match(rssMode, /import \{ getRSSWarmCache, primeRSSWarmCache, setRSSWarmCache \} from '\.\.\/\.\.\/modules\/rss\/rssWarmCache'/)
  assert.match(rssMode, /const applyRSSSnapshot = useCallback\(\(snapshot:/)
  assert.match(rssMode, /const loadRSSSnapshot = useCallback\(async \(\) => \{/)
  assert.match(rssMode, /useEffect\(\(\) => \{[\s\S]*void primeRSSWarmCache\(loadRSSSnapshot\)/)
  assert.match(rssMode, /const cachedSnapshot = getRSSWarmCache\(\)/)
  assert.match(rssMode, /if \(cachedSnapshot\) \{[\s\S]*applyRSSSnapshot\(cachedSnapshot\)/)
  assert.match(rssMode, /const shouldPoll = isActive && hasHydrated/)
  assert.match(rssMode, /if \(!isActive\) \{/)
  assert.match(rssMode, /!cancelled && !hasHydrated[\s\S]*setHasHydrated\(true\)/)

  assert.match(calendarMode, /interface CalendarModeProps \{[\s\S]*isActive\?: boolean[\s\S]*isMotionSettled\?: boolean[\s\S]*\}/)
  assert.match(calendarMode, /export default function CalendarMode\(\{[\s\S]*isActive = true,[\s\S]*isMotionSettled = true,[\s\S]*\}: CalendarModeProps\)/)
  assert.match(calendarMode, /const \[hasActivated, setHasActivated\] = useState\(/)
  assert.match(calendarMode, /if \(!hasActivated\) return/)

  assert.match(documentMode, /interface DocumentModeProps \{[\s\S]*isActive\?: boolean[\s\S]*isMotionSettled\?: boolean[\s\S]*\}/)
  assert.match(documentMode, /export default function DocumentMode\(\{[\s\S]*isActive = true,[\s\S]*isMotionSettled = true,[\s\S]*\}: DocumentModeProps\)/)
  assert.match(documentMode, /const \[hasActivated, setHasActivated\] = useState\(isActive\)/)
  assert.match(documentMode, /if \(!hasActivated \|\| !selectedFile\) return undefined/)
  assert.match(previewBrowser, /export default function PreviewBrowser\(\{ item, onClose, isActive = true \}:/)
  assert.match(previewBrowser, /if \(!isActive\) \{[\s\S]*previewClose/)
})
