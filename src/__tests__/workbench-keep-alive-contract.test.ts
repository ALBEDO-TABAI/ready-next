import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench outlet only keeps the active mode and the outgoing mode mounted during transitions', () => {
  const outlet = readWorkspaceFile('src/renderer/components/layout/WorkbenchModeOutlet.tsx')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(outlet, /const ALL_WORKBENCH_MODES: WorkbenchMode\[\] = \['browser', 'document', 'rss', 'calendar'\]/)
  assert.match(outlet, /const \[lastActiveMode, setLastActiveMode\] = useState<WorkbenchMode>\(mode\)/)
  assert.match(outlet, /const \[transitioningFrom, setTransitioningFrom\] = useState<WorkbenchMode \| null>\(null\)/)
  assert.match(outlet, /const modesToRender = useMemo\(\(\) => \{/)
  assert.match(outlet, /if \(!modesToRender\.has\(mountedMode\)\) \{/)
  assert.match(outlet, /data-skipped-mode=\{mountedMode\}/)
  assert.match(outlet, /isMotionSettled=\{isActive \? isMotionSettled : false\}/)
  assert.match(outlet, /aria-hidden=\{!isActive\}/)
  assert.doesNotMatch(outlet, /allowEarlyHostReveal/)
  assert.doesNotMatch(outlet, /motion\.div/)
  assert.match(topBar, /onWorkbenchModeChange\?: \(mode: WorkbenchMode\) => void \| Promise<void>/)
  assert.match(topBar, /if \(onWorkbenchModeChange\) \{/)
  assert.match(workbenchMode, /const \[modeTransition, setModeTransition\] = useState<ModeTransitionState \| null>\(null\)/)
  assert.match(workbenchMode, /const \[contentMotion, setContentMotion\] = useState<ContentMotionState \| null>\(null\)/)
  assert.match(workbenchMode, /const \[isModeTransitionSettled, setIsModeTransitionSettled\] = useState\(true\)/)
  assert.match(workbenchMode, /captureWindowSnapshot/)
  assert.match(workbenchMode, /const handleWorkbenchModeChange = useCallback\(async \(nextMode: WorkbenchMode(?:Type)?\) => \{/)
  assert.match(workbenchMode, /setModeTransition\(\{[\s\S]*src:\s*snapshotSrc[\s\S]*direction,[\s\S]*kind,[\s\S]*\}\)/)
  assert.match(workbenchMode, /setContentMotion\(\{[\s\S]*active:\s*true[\s\S]*phase:\s*'entering'[\s\S]*\}\)/)
  assert.match(workbenchMode, /modeTransition && \(/)
  assert.match(workbenchMode, /<motion\.div/)
})

test('workbench parent shell animates one leaving snapshot plus one entering live panel instead of two live layers', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.match(workbenchMode, /function resolveWorkbenchTransitionKind\(from: WorkbenchModeType, to: WorkbenchModeType\): TransitionKind/)
  assert.match(workbenchMode, /type TransitionKind = 'horizontal' \| 'browser-exit' \| 'browser-enter'/)
  assert.match(workbenchMode, /const WORKBENCH_HORIZONTAL_TRAVEL = '100%'/)
  assert.match(workbenchMode, /const queuedModeRef = useRef<WorkbenchModeType \| null>\(null\)/)
  assert.match(workbenchMode, /function getContentMotionInitialFrame\(contentMotion: ContentMotionState \| null\)/)
  assert.match(workbenchMode, /function getContentMotionAnimateFrame\(contentMotion: ContentMotionState \| null\)/)
  assert.match(workbenchMode, /if \(contentMotion\.kind === 'browser-enter'\) \{[\s\S]*return \{ x: '0%', y: 0, scale: 1, opacity: 1 \}/)
  assert.match(workbenchMode, /if \(modeTransition\.kind === 'browser-exit'\) \{[\s\S]*return \{ x: '0%', y: 0, scale: 1, opacity: 0 \}/)
  assert.match(workbenchMode, /animate=\{[\s\S]*contentMotion\?\.phase === 'entering'[\s\S]*\? getContentMotionInitialFrame\(contentMotion\)[\s\S]*: getContentMotionAnimateFrame\(contentMotion\)[\s\S]*\}/)
  assert.match(workbenchMode, /animate=\{[\s\S]*contentMotion\?\.phase === 'entering'[\s\S]*\? getContentMotionInitialFrame\(contentMotion\)[\s\S]*: getContentMotionAnimateFrame\(contentMotion\)[\s\S]*\}/)
  assert.match(workbenchMode, /animate=\{getOverlayExitFrame\(modeTransition\)\}/)
  assert.match(workbenchMode, /setIsModeTransitionSettled\(false\)/)
  assert.match(workbenchMode, /setIsModeTransitionSettled\(true\)/)
  assert.match(workbenchMode, /if \(!isModeTransitionSettled\) \{[\s\S]*queuedModeRef\.current = nextMode[\s\S]*return/)
  assert.match(workbenchMode, /modeTransition && \(/)
  assert.match(workbenchMode, /BROWSER_OVERLAY_LOCK_EVENT/)
  assert.doesNotMatch(workbenchMode, /if \(nextMode === workbenchMode \|\| !isModeTransitionSettled\) return/)
})

test('rss and calendar modes gate heavyweight work behind foreground activity when kept alive', () => {
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const previewBrowser = readWorkspaceFile('src/renderer/components/rss/PreviewBrowser.tsx')

  assert.match(rssMode, /export default function RSSMode\(\{ isActive = true \}:\s*\{ isActive\?: boolean \}\)/)
  assert.match(rssMode, /const shouldPoll = isActive && hasHydrated/)
  assert.match(rssMode, /if \(!isActive\) \{/)
  assert.match(rssMode, /!cancelled && !hasHydrated[\s\S]*setHasHydrated\(true\)/)

  assert.match(calendarMode, /export default function CalendarMode\(\{ isActive = true \}:\s*\{ isActive\?: boolean \}\)/)
  assert.match(calendarMode, /const \[hasActivated, setHasActivated\] = useState\(/)
  assert.match(calendarMode, /if \(!hasActivated\) return/)

  assert.match(documentMode, /export default function DocumentMode\(\{ isActive = true \}:\s*\{ isActive\?: boolean \}\)/)
  assert.match(previewBrowser, /export default function PreviewBrowser\(\{ item, onClose, isActive = true \}:/)
  assert.match(previewBrowser, /if \(!isActive\) \{[\s\S]*previewClose/)
})
