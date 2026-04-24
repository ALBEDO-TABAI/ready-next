import { Suspense, lazy, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import WorkbenchMode from './pages/WorkbenchMode'
import ReadyMode from './pages/ReadyMode'
import Settings from './pages/Settings'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { ErrorBoundary } from './components/ErrorBoundary'
import RitualOverlay from './components/overlay/RitualOverlay'
import SkillAskUserPrompt from './components/skill/SkillAskUserPrompt'
import { useTheme } from './stores/useTheme'
import { initAgentListeners } from './stores/useAgent'
import { fetchRSSWarmSnapshot } from './modules/rss/rssWarmLoader'
import { primeRSSWarmCache } from './modules/rss/rssWarmCache'

const LiquidTest = lazy(() => import('./LiquidTest'))

void primeRSSWarmCache(fetchRSSWarmSnapshot).catch(() => undefined)

function App() {
  useKeyboardShortcuts()

  // `data-theme` is owned exclusively by useTheme (sync for bypass/system/init paths,
  // deferred to the ritual overlay's holding phase for user-driven toggles). Subscribing
  // here would race the ritual and re-introduce the 3-flash bug.
  const skin = useTheme(s => s.skin)

  useEffect(() => {
    document.documentElement.setAttribute('data-skin', skin)
  }, [skin])

  // Keep agent tool/event listeners alive at app root to avoid missed tool actions
  // when chat panel remounts.
  useEffect(() => {
    const cleanup = initAgentListeners()
    return cleanup
  }, [])

  useEffect(() => {
    void primeRSSWarmCache(fetchRSSWarmSnapshot).catch(() => undefined)
  }, [])

  return (
    <ErrorBoundary>
      <div className="ready-app-shell h-screen w-screen flex flex-col bg-[var(--bg-primary)] overflow-hidden">
        <div className="ready-app-bg" aria-hidden="true" />
        <div className="ready-theme-ritual-tint" aria-hidden="true" />
        <div className="ready-app-content h-full min-h-0 flex flex-col">
          <Routes>
            <Route path="/" element={<WorkbenchMode />} />
            <Route path="/workbench" element={<WorkbenchMode />} />
            <Route path="/ready" element={<ReadyMode />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="/liquid-test"
              element={(
                <Suspense fallback={<div className="h-full w-full" />}>
                  <LiquidTest />
                </Suspense>
              )}
            />
            <Route path="*" element={<Navigate to="/workbench" replace />} />
          </Routes>
        </div>
      </div>
      <RitualOverlay />
      <SkillAskUserPrompt />
    </ErrorBoundary>
  )
}

export default App
