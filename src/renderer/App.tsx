import { Suspense, lazy, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import WorkbenchMode from './pages/WorkbenchMode'
import ReadyMode from './pages/ReadyMode'
import Settings from './pages/Settings'
import PetWindow from './pages/PetWindow'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { ErrorBoundary } from './components/ErrorBoundary'
import RitualOverlay from './components/overlay/RitualOverlay'
import SkillAskUserPrompt from './components/skill/SkillAskUserPrompt'
import SkillInlinedToast from './components/skill/SkillInlinedToast'
import { initAgentListeners } from './stores/useAgent'
import { usePetActivityBridge } from './modules/pet/usePetActivityBridge'
import { fetchRSSWarmSnapshot } from './modules/rss/rssWarmLoader'
import { primeRSSWarmCache } from './modules/rss/rssWarmCache'

const LiquidTest = lazy(() => import('./LiquidTest'))

void primeRSSWarmCache(fetchRSSWarmSnapshot).catch(() => undefined)

function MainAppShell() {
  useKeyboardShortcuts()
  usePetActivityBridge()

  // `data-theme` 与 `data-skin` / `data-glass-backdrop` 都由 useTheme 单点拥有
  // （useTheme.applySkin 在模块初始化时设置，setSkin/toggleSkin 时更新）。
  // 这里**不再**重复设置 data-skin，避免与 applySkin 形成 race。

  useEffect(() => {
    // `data-native-fullscreen` attr 控制 `.ready-app-bg` 是否承担 fullscreen backing（防壁纸泄漏）。
    // 它**只**应该在"纯原生窗口全屏"（用户走 CMD+CTRL+F / 窗口绿按钮，BrowserWindow 进独立 Space）
    // 期间设置，在 **HTML5 fullscreen（页面里 element.requestFullscreen()，如 B 站 iframe 视频全屏）**
    // 期间**绝不**设置——因为 iframe `:fullscreen` UA CSS + `::backdrop` 已经盖了一切，
    // `.ready-app-bg` 没有任何角色；反而设了 attr 会因为 OOPIF 路径下 `BrowserWindow.leave-full-screen`
    // IPC 不可靠而卡死在 'true'，让 dark gradient 透过 glass surface 显成"外框黑屏"。
    //
    // 决策合同：`attr ⟺ (IPC 报 native) ∧ ¬(document.fullscreenElement 非空)`。
    // 两个信号 OR-NOT，任何一个说"HTML5 fullscreen 活跃"或"IPC 说退出"都立刻清 attr。
    // `fullscreenchange` 是 W3C 标准事件、renderer 内部同步触发，不走 IPC，作为 OOPIF 路径不可靠的兜底。
    let nativeWindowFullscreen = false
    let htmlFullscreenActive = false

    const reconcile = (): void => {
      const root = document.documentElement
      if (nativeWindowFullscreen && !htmlFullscreenActive) {
        root.setAttribute('data-native-fullscreen', 'true')
      } else {
        root.removeAttribute('data-native-fullscreen')
      }
    }

    const onFsChange = (): void => {
      htmlFullscreenActive = document.fullscreenElement !== null
      reconcile()
    }
    document.addEventListener('fullscreenchange', onFsChange)

    const unsubIPC = window.electronAPI?.window?.onFullscreenChanged?.((isFullscreen) => {
      nativeWindowFullscreen = isFullscreen
      reconcile()
    }) ?? (() => undefined)

    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      unsubIPC()
    }
  }, [])

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
            <Route path="/pet-window" element={<PetWindow />} />
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
      <SkillInlinedToast />
    </ErrorBoundary>
  )
}

function App() {
  const location = useLocation()
  if (location.pathname === '/pet-window') {
    return (
      <ErrorBoundary>
        <PetWindow />
      </ErrorBoundary>
    )
  }

  return <MainAppShell />
}

export default App
