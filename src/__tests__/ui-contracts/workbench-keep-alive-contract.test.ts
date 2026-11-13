import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { buildSync } from 'esbuild'
import type { CalendarNavigationRequest } from '../../shared/calendar/desktop'

function readWorkspaceFile(path: string): string {
  // allow-source-grep: Preserve existing shell, RSS and document guards; calendar activity is exercised below.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench outlet keeps all modes mounted and routes mode switching through the ritual overlay', () => {
  const outlet = readWorkspaceFile('src/renderer/components/layout/WorkbenchModeOutlet.tsx')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const chatPanel = readWorkspaceFile('src/renderer/components/agent/ChatPanel.tsx')
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const keyboardShortcuts = readWorkspaceFile('src/renderer/hooks/useKeyboardShortcuts.ts')
  const modeTransition = readWorkspaceFile('src/renderer/modules/workbench/mode-transition.ts')

  assert.match(outlet, /const ALL_WORKBENCH_MODES: WorkbenchMode\[\] = \['browser', 'document', 'rss', 'calendar'\]/)
  assert.match(outlet, /const ALL_MODE_LOADERS = \[loadBrowserMode, loadDocumentMode, loadRSSMode, loadCalendarMode\]/)
  assert.match(outlet, /let hasPreloadedWorkbenchModes = false/)
  assert.match(outlet, /useEffect\(\(\) => \{[\s\S]*if \(hasPreloadedWorkbenchModes\) return[\s\S]*ALL_MODE_LOADERS\.forEach\(\(loadMode\) => \{[\s\S]*void loadMode\(\)/)
  assert.match(outlet, /const ModeScene = memo\(function ModeScene/)
  assert.match(outlet, /className="workbench-mode-scene"/)
  assert.match(outlet, /pointerEvents: visualState === 'current' && !suspended \? 'auto' : 'none'/)
  assert.match(outlet, /visibility: suspended \? 'hidden' : 'visible'/)
  assert.match(outlet, /data-mode-visual-state=\{visualState\}/)
  assert.match(outlet, /data-mode-direction=\{direction\}/)
  assert.match(outlet, /aria-hidden=\{!isActive \|\| suspended\}/)
  assert.match(outlet, /isActive=\{modeKey === runtime\.current && !suspended\}/)
  assert.match(outlet, /isSuspended=\{suspended\}/)
  assert.match(outlet, /isMotionSettled=\{isActive \? isMotionSettled : false\}/)
  assert.match(outlet, /const MODE_SCENE_TRANSITION_MS = WORKBENCH_MODE_SCENE_TRANSITION_MS/)
  assert.match(modeTransition, /export const WORKBENCH_MODE_SCENE_TRANSITION_MS = 280/)
  assert.doesNotMatch(outlet, /MODE_LEAVING_OFFSET_PERCENT/)
  assert.doesNotMatch(outlet, /MODE_LEAVING_FADE_OPACITY/)
  assert.doesNotMatch(outlet, /resolveModeDirection/)
  assert.doesNotMatch(outlet, /leavingMode/)
  assert.doesNotMatch(outlet, /allowEarlyHostReveal/)
  assert.doesNotMatch(outlet, /motion\.div/)
  assert.doesNotMatch(outlet, /contentVisibility:/)

  assert.doesNotMatch(topBar, /onWorkbenchModeChange/)
  // V20: two places switch modes, one state. The rail and the slot above the composer both call the shell's handlers;
  // the assistant only places the slot it is given and owns no mode state or handler of its own.
  assert.doesNotMatch(chatPanel, /onWorkbenchModeChange|DraggableModeTabs|setWorkbenchMode/)
  assert.match(workbenchMode, /<ChatPanel[\s\S]*workbenchMode=\{workbenchMode\}/)
  assert.match(workbenchMode, /<ShellRail[\s\S]*onModeChange=\{\(mode\) => \{ void handleWorkbenchModeChange\(mode\) \}\}[\s\S]*onSplitToggle=\{handleWorkbenchSplitToggle\}/)
  assert.match(workbenchMode, /modeSwitcher=\{\(\s*<DraggableModeTabs\s+activeMode=\{workbenchMode\}\s+splitMode=\{splitMode\}\s+onChange=\{\(mode\) => \{ void handleWorkbenchModeChange\(mode\) \}\}\s+onSplitToggle=\{handleWorkbenchSplitToggle\}/)

  assert.match(workbenchMode, /import \{[^}]*withRitual[^}]*\} from '\.\.\/modules\/overlay\/useRitualOverlay'/)
  assert.match(workbenchMode, /resolveModeTransitionStrategy\(workbenchMode, nextMode\)/)
  assert.match(workbenchMode, /resolveBrowserVisibilityTransition\(/)
  assert.match(workbenchMode, /const \[isMotionSettled, setIsMotionSettled\] = useState\(true\)/)
  assert.match(workbenchMode, /const \[modeScenePresentation, setModeScenePresentation\] = useState<WorkbenchModeChangePresentation>\('animated'\)/)
  assert.match(workbenchMode, /const handleWorkbenchModeChange = useCallback\(async function handleWorkbenchModeChange/)
  assert.match(workbenchMode, /if \(strategy === 'same-mode'\) \{[\s\S]*reconcileBrowserVisibilityAfterModeDecision\([\s\S]*return[\s\S]*\}/)
  assert.match(workbenchMode, /const requestId = beginModeChangeRequest\(\)[\s\S]*const strategy = resolveModeTransitionStrategy/)
  assert.match(workbenchMode, /cancelRitual\('mode-switch'\)/)
  assert.match(workbenchMode, /if \(splitMode\) \{[\s\S]*setWorkbenchMode\(nextMode\)[\s\S]*return/)
  assert.match(workbenchMode, /await withRitual\('mode-switch', async \(\{ signalReady \}\) => \{[\s\S]*setWorkbenchMode\(nextMode\)[\s\S]*signalReady\(\)/)
  assert.match(workbenchMode, /setIsMotionSettled\(false\)/)
  assert.match(workbenchMode, /setIsMotionSettled\(true\)/)
  assert.doesNotMatch(workbenchMode, /const MODE_TRANSITION_DURATION_MS = 350/)
  assert.doesNotMatch(workbenchMode, /const transitionTimerRef = useRef/)
  assert.doesNotMatch(workbenchMode, /transitionTimerRef\.current = window\.setTimeout/)
  assert.match(workbenchMode, /READY_WORKBENCH_MODE_CHANGE_EVENT/)
  assert.match(workbenchMode, /detail\.placement === 'open'/)
  assert.match(workbenchMode, /window\.addEventListener\(READY_WORKBENCH_MODE_CHANGE_EVENT, handleExternalWorkbenchModeChange as EventListener\)/)
  assert.match(workbenchMode, /<WorkbenchModeOutlet[\s\S]*mode=\{workbenchMode\}[\s\S]*transitionPresentation=\{modeScenePresentation\}[\s\S]*isMotionSettled=\{isMotionSettled\}[\s\S]*browserLayoutPhase=\{browserLayoutPhase\}[\s\S]*\/>/)
  // V19: the graph and find-and-replace both take the mode panel's box, so either suspends the mode underneath.
  assert.match(workbenchMode, /suspended=\{graphWorkspaceRequest !== null \|\| findReplaceOpen\}/)
  assert.match(workbenchMode, /const pendingRoots = new Set<string>\(\)/)
  assert.match(workbenchMode, /window\.setTimeout\(\(\) => \{[\s\S]*Promise\.all\(roots\.map\(\(root\) => invalidateGraphWorkspace\(root\)\)\)[\s\S]*\}, 50\)/)
  assert.match(modeTransition, /export const READY_WORKBENCH_MODE_CHANGE_EVENT = 'ready:workbench-mode-change-request'/)
  assert.match(modeTransition, /requestWorkbenchModeChange/)
  assert.match(keyboardShortcuts, /requestWorkbenchModeChange\(mode\)/)
  assert.match(keyboardShortcuts, /if \(appMode === 'workbench'\)/)
})

test('workbench shell hides all browser hosts on unmount (show/hide during mode change is now consolidated inside useBrowserViewBounds)', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const boundsHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')

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
  assert.match(
    boundsHook,
    /useEffect\(\(\) => \(\) => \{[\s\S]*visibilitySyncTokenRef\.current \+= 1[\s\S]*kind: 'hide-all'[\s\S]*reason: 'mode-switch-prepare'/,
  )
})

test('rss and calendar modes gate heavyweight work behind foreground activity when kept alive', async () => {
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const previewBrowser = readWorkspaceFile('src/renderer/components/rss/PreviewBrowser.tsx')

  assert.match(rssMode, /interface RSSModeProps \{[\s\S]*isActive\?: boolean[\s\S]*isMotionSettled\?: boolean[\s\S]*\}/)
  assert.match(rssMode, /export default function RSSMode\(\{[\s\S]*isActive = true,[\s\S]*isSuspended = false,[\s\S]*isMotionSettled = true,[\s\S]*\}: RSSModeProps\)/)
  assert.doesNotMatch(rssMode, /if \(isSuspended\) return null/)
  assert.match(rssMode, /const shouldPoll = isActive && !isSuspended && hasHydrated/)
  assert.match(rssMode, /if \(suspendedRef\.current\) \{[\s\S]*pendingAutoRefreshSnapshotRef\.current = snapshot[\s\S]*return/)
  assert.match(rssMode, /if \(isSuspended\) return[\s\S]*pendingAutoRefreshSnapshotRef\.current = null[\s\S]*loadRSSData\(\{ background: true \}\)/)
  assert.match(rssMode, /useRSSWorkspace\(isActive && !isSuspended\)/)

  assert.match(documentMode, /interface DocumentModeProps \{[\s\S]*isActive\?: boolean[\s\S]*isMotionSettled\?: boolean[\s\S]*\}/)
  assert.match(documentMode, /export default function DocumentMode\(\{[\s\S]*isActive = true,[\s\S]*isMotionSettled = true,[\s\S]*\}: DocumentModeProps\)/)
  assert.match(documentMode, /shouldHandleSelectedDocument\(\{[\s\S]*isActive,[\s\S]*selectedFile,/)
  assert.doesNotMatch(documentMode, /const \[hasActivated, setHasActivated\] = useState\(isActive\)/)
  assert.match(previewBrowser, /export default function PreviewBrowser\(\{ item, onClose, isActive = true \}:/)
  assert.match(previewBrowser, /if \(!isActive\) \{[\s\S]*previewClose/)

  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  const replacements = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, clearInterval: (id: number) => dom.window.clearInterval(id),
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const root = createRoot(dom.window.document.getElementById('root')!)
  const counts: { snapshots: number; login: number; navigation: number; subscriptions: number; timers: number; mentions?: number; layers?: number } = { snapshots: 0, login: 0, navigation: 0, subscriptions: 0, timers: 0 }
  const changes = new Set<() => void>()
  let listeners = 0
  const subscribe = () => { counts.subscriptions++; listeners++; return () => { listeners-- } }
  const timers = new Set<number>()
  const setInterval = dom.window.setInterval.bind(dom.window), clearInterval = dom.window.clearInterval.bind(dom.window)
  dom.window.setInterval = (handler, timeout) => {
    counts.timers++
    const id = setInterval(handler, timeout); timers.add(id); return id
  }
  dom.window.clearInterval = id => { timers.delete(id); clearInterval(id) }
  let navigation: CalendarNavigationRequest | null = null
  const acknowledged: string[] = []
  let finishLoading!: () => void
  const loading = new Promise<void>(resolve => { finishLoading = resolve })
  try {
    Object.assign(dom.window, { electronAPI: { calendar: {
      snapshot: async () => { counts.snapshots++; await loading; return { success: true, data: { calendars: [], events: [] } } },
      getLoginItem: async () => { counts.login++; return { success: true, data: false } },
      onChanged: (handler: () => void) => { const off = subscribe(); changes.add(handler); return () => { off(); changes.delete(handler) } },
      peekNavigation: async () => { counts.navigation++; return { success: true, data: navigation } },
      ackNavigation: async (id: string) => { acknowledged.push(id); navigation = null; return { success: true } },
      onNavigation: subscribe, onRemoteEventSuggested: subscribe, onReminderFired: subscribe,
    }, dateMentions: {
      // The calendar's date-mention layer (M6-C) opens reminders only while the calendar is in front.
      takeOpen: async () => { counts.mentions = (counts.mentions ?? 0) + 1; return null }, onOpen: subscribe, onChanged: subscribe,
    }, calendarLayers: {
      // The four calendar layers (M6-B) read their entries the same way.
      query: async () => { counts.layers = (counts.layers ?? 0) + 1; return { ok: true, value: { entries: [] } } }, onChanged: subscribe,
    }, vault: { onChanged: subscribe }, canvas: { onChanged: subscribe }, documentPages: { onChanged: subscribe },
    calendarLinkage: { day: async () => ({ ok: true, value: { date: '', events: [], dates: [], reminders: [], reading: [], objects: [] } }) } } })
    // Exercise the real mode, workbench and store; replace only browser/native boundaries.
    const compiled = buildSync({
      entryPoints: ['src/renderer/pages/modes/CalendarMode.tsx'], bundle: true, write: false,
      platform: 'browser', format: 'cjs', jsx: 'automatic', tsconfig: 'tsconfig.web.json',
      loader: { '.css': 'empty' }, external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    }).outputFiles[0].text
    const loaded = { exports: {} as { default: typeof import('../../renderer/pages/modes/CalendarMode').default } }
    new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), loaded, loaded.exports)
    const render = (isActive: boolean, isMotionSettled = true) => act(async () => {
      root.render(createElement(loaded.exports.default, { isActive, isMotionSettled }))
    })
    await render(false)
    await render(true, false)
    assert.deepEqual(counts, { snapshots: 0, login: 0, navigation: 0, subscriptions: 0, timers: 0 })
    await render(true)
    assert.equal(counts.snapshots, 1)
    assert.equal(counts.login, 1)
    assert.equal(changes.size, 1)
    assert.equal(counts.subscriptions, 1)
    assert.equal(timers.size, 1)
    await render(false)
    assert.equal(timers.size, 0, 'background mode must stop its clock')
    await render(true)
    assert.equal(counts.snapshots, 1, 'switching while loading must not restart initialization')
    await act(async () => finishLoading())
    const calendar = dom.window.document.querySelector('.app')
    assert.ok(calendar, 'the real calendar must finish loading')
    // Navigation, remote events and reminders, plus the date-mention and layer subscriptions the calendar gained in M6.
    assert.equal(listeners, 8)
    assert.equal(counts.snapshots, 1, 'empty navigation must not read another snapshot')
    const initialized = { ...counts }
    await render(false)
    assert.equal(timers.size, 0)
    assert.deepEqual(counts, initialized, 'moving to background must not start work')
    await render(true)
    assert.equal(counts.snapshots, 1, 'returning to unchanged data must not initialize again')
    assert.equal(counts.login, 1)
    assert.equal(dom.window.document.querySelector('.app'), calendar, 'switching must preserve the calendar')
    assert.equal(timers.size, 1, 'only one clock may be running')
    await render(false)
    await act(async () => { changes.forEach(handler => handler()); changes.forEach(handler => handler()) })
    assert.equal(counts.snapshots, 1, 'background changes must defer reading')
    await render(true)
    assert.equal(counts.snapshots, 2, 'foreground must read back accumulated background changes once')
    await act(async () => { changes.forEach(handler => handler()) })
    assert.equal(counts.snapshots, 3, 'foreground changes must still refresh the calendar')
    await render(false)
    navigation = { id: 'pending-day', target: { kind: 'day', date: '2099-06-15' } }
    await render(true)
    assert.equal(counts.snapshots, 4, 'a real pending navigation must still load current data')
    assert.deepEqual(acknowledged, ['pending-day'])
    assert.equal(calendar.querySelector('.topbar-title .yr')?.textContent, '2099')
  } finally {
    finishLoading()
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  assert.equal(listeners, 0, 'unmount must release every subscription')
  assert.equal(timers.size, 0, 'unmount must stop the clock')
})
