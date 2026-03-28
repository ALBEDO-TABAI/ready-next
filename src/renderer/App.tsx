import { Suspense, lazy, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import WorkbenchMode from './pages/WorkbenchMode'
import ReadyMode from './pages/ReadyMode'
import Settings from './pages/Settings'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useTheme } from './stores/useTheme'
import { initAgentListeners } from './stores/useAgent'

const LiquidTest = lazy(() => import('./LiquidTest'))

function App() {
  useKeyboardShortcuts()

  // Apply theme on mount — the store initializer already sets data-theme,
  // but this ensures the component subscribes so system-theme changes
  // trigger a re-render if needed.
  const resolvedTheme = useTheme(s => s.resolvedTheme)
  const skin = useTheme(s => s.skin)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    document.documentElement.setAttribute('data-skin', skin)
  }, [skin])

  // Keep agent tool/event listeners alive at app root to avoid missed tool actions
  // when chat panel remounts.
  useEffect(() => {
    const cleanup = initAgentListeners()
    return cleanup
  }, [])

  return (
    <ErrorBoundary>
      <div className="ready-app-shell h-screen w-screen flex flex-col bg-[var(--bg-primary)] overflow-hidden">
        <div className="ready-app-bg" aria-hidden="true" />
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
    </ErrorBoundary>
  )
}

export default App
