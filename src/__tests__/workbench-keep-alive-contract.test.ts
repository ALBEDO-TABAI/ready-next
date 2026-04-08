import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench outlet keeps all modes mounted in one horizontal strip and gates visibility by active adjacency and motion state', () => {
  const outlet = readWorkspaceFile('src/renderer/components/layout/WorkbenchModeOutlet.tsx')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const keyboardShortcuts = readWorkspaceFile('src/renderer/hooks/useKeyboardShortcuts.ts')
  const modeTransition = readWorkspaceFile('src/renderer/modules/workbench/mode-transition.ts')

  assert.match(outlet, /const ALL_WORKBENCH_MODES: WorkbenchMode\[\] = \['browser', 'document', 'rss', 'calendar'\]/)
  assert.match(outlet, /const ALL_MODE_LOADERS = \[loadBrowserMode, loadDocumentMode, loadRSSMode, loadCalendarMode\]/)
  assert.match(outlet, /let hasPreloadedWorkbenchModes = false/)
  assert.match(outlet, /useEffect\(\(\) => \{[\s\S]*if \(hasPreloadedWorkbenchModes\) return[\s\S]*ALL_MODE_LOADERS\.forEach\(\(loadMode\) => \{[\s\S]*void loadMode\(\)/)
  assert.match(outlet, /const activeIndex = useMemo\(\(\) => \{[\s\S]*ALL_WORKBENCH_MODES\.indexOf\(mode\)/)
  assert.match(outlet, /transform: `translateX\(-\$\{activeIndex \* 100\}%\)`/)
  assert.match(outlet, /transition: isMotionSettled[\s\S]*\? 'none'[\s\S]*: 'transform 0\.35s cubic-bezier\(0\.24, 1, 0\.36, 1\)'/)
  assert.match(outlet, /const isAdjacent = Math\.abs\(index - activeIndex\) <= 1/)
  assert.match(outlet, /contentVisibility: isAdjacent \? 'auto' : 'hidden'/)
  assert.match(outlet, /contain: 'strict'/)
  assert.match(outlet, /isMotionSettled=\{isActive \? isMotionSettled : false\}/)
  assert.match(outlet, /aria-hidden=\{!isActive\}/)
  assert.doesNotMatch(outlet, /allowEarlyHostReveal/)
  assert.doesNotMatch(outlet, /motion\.div/)

  assert.match(topBar, /onWorkbenchModeChange\?: \(mode: WorkbenchMode\) => void \| Promise<void>/)
  assert.match(topBar, /if \(onWorkbenchModeChange\) \{[\s\S]*void onWorkbenchModeChange\(mode\)/)

  assert.match(workbenchMode, /const MODE_TRANSITION_DURATION_MS = 350/)
  assert.match(workbenchMode, /const \[isMotionSettled, setIsMotionSettled\] = useState\(true\)/)
  assert.match(workbenchMode, /const transitionTimerRef = useRef<number \| null>\(null\)/)
  assert.match(workbenchMode, /const pendingWorkbenchModeRef = useRef<WorkbenchMode(?:Type)? \| null>\(null\)/)
  assert.match(workbenchMode, /const transitionTargetModeRef = useRef<WorkbenchMode(?:Type)>\(workbenchMode\)/)
  assert.match(workbenchMode, /const handleWorkbenchModeChange = useCallback/)
  assert.match(workbenchMode, /if \(nextMode === workbenchMode\) return/)
  assert.match(workbenchMode, /if \(splitMode\) \{[\s\S]*setWorkbenchMode\(nextMode\)[\s\S]*return/)
  assert.match(workbenchMode, /if \(!isMotionSettled\) \{[\s\S]*pendingWorkbenchModeRef\.current = nextMode[\s\S]*return/)
  assert.match(workbenchMode, /setIsMotionSettled\(false\)/)
  assert.match(workbenchMode, /setWorkbenchMode\(nextMode\)/)
  assert.match(workbenchMode, /transitionTimerRef\.current = window\.setTimeout\(\(\) => \{[\s\S]*const queuedMode = pendingWorkbenchModeRef\.current/)
  assert.match(workbenchMode, /if \(queuedMode && queuedMode !== transitionTargetModeRef\.current\) \{[\s\S]*handleWorkbenchModeChange\(queuedMode\)/)
  assert.match(workbenchMode, /setIsMotionSettled\(true\)/)
  assert.match(workbenchMode, /if \(transitionTimerRef\.current\) \{[\s\S]*window\.clearTimeout\(transitionTimerRef\.current\)/)
  assert.match(workbenchMode, /READY_WORKBENCH_MODE_CHANGE_EVENT/)
  assert.match(workbenchMode, /window\.addEventListener\(READY_WORKBENCH_MODE_CHANGE_EVENT, handleExternalWorkbenchModeChange as EventListener\)/)
  assert.match(workbenchMode, /<WorkbenchModeOutlet mode=\{workbenchMode\} isMotionSettled=\{isMotionSettled\} \/>/)
  assert.match(modeTransition, /export const READY_WORKBENCH_MODE_CHANGE_EVENT = 'ready:workbench-mode-change-request'/)
  assert.match(modeTransition, /requestWorkbenchModeChange/)
  assert.match(keyboardShortcuts, /requestWorkbenchModeChange\(mode\)/)
  assert.match(keyboardShortcuts, /if \(appMode === 'workbench'\)/)
})

test('workbench shell hides all browser hosts whenever browser is outside the visible mode set and on unmount', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(workbenchMode, /const visibleModes = \[workbenchMode, splitMode\]\.filter\(Boolean\)/)
  assert.match(workbenchMode, /if \(!visibleModes\.includes\('browser'\)\) \{[\s\S]*void window\.electronAPI\?\.browser\.hideAll\(\)/)
  assert.match(workbenchMode, /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*void window\.electronAPI\?\.browser\.hideAll\(\)/)
  assert.doesNotMatch(workbenchMode, /browser\.hideActiveHost\(\)/)
})

test('rss and calendar modes gate heavyweight work behind foreground activity when kept alive', () => {
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const previewBrowser = readWorkspaceFile('src/renderer/components/rss/PreviewBrowser.tsx')

  assert.match(rssMode, /interface RSSModeProps \{[\s\S]*isActive\?: boolean[\s\S]*isMotionSettled\?: boolean[\s\S]*\}/)
  assert.match(rssMode, /export default function RSSMode\(\{[\s\S]*isActive = true,[\s\S]*isMotionSettled = true,[\s\S]*\}: RSSModeProps\)/)
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
