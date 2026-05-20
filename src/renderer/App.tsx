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

// fire-and-forget: module-load warm cache prime; failure just means the first RSS read runs cold.
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
    // **验证 3 修正（2026-05-16）**：之前用 `(nativeWindowFullscreen && !htmlFullscreenActive)`
    // OR-NOT 逻辑有缺陷——`nativeWindowFullscreen` 在 OOPIF iframe 退出后会卡在陈旧的 `true`，
    // 当 `htmlFullscreenActive` 转 false 时 reconcile 反而把 attr 设回 'true'，bug 复现。
    //
    // 现在的合同：main 进程的 IPC 是 **authoritative** 的 native fullscreen 状态（验证 3 给
    // controller 加了 webContents.{enter,leave}-html-full-screen 兜底，传 `window.isFullScreen()`
    // 真实查询值）。Renderer 完全信 IPC，**不再**在 fullscreenchange 里读 nativeWindowFullscreen 做
    // OR-NOT——只保留 fullscreenchange 作为本地 HTML5 fullscreen 状态的最快信号（防止 IPC 还没到时
    // attr 错误设置）。
    //
    // 决策：`attr ⟺ IPC 最近一次推送的值 ∧ ¬(document.fullscreenElement 非空)`。
    let nativeWindowFullscreenFromIPC = false
    let htmlFullscreenActive = false

    const reconcile = (): void => {
      const root = document.documentElement
      // 任意一边说"HTML5 fullscreen 活跃" → 不设 attr（验证 2 + 验证 3 的共同结论）
      // 只在 main 进程权威信号说 native fullscreen + renderer 自己不在 HTML5 fullscreen 时设
      if (nativeWindowFullscreenFromIPC && !htmlFullscreenActive) {
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
      // main 进程的 IPC 是 authoritative。webContents.leave-html-full-screen 兜底确保
      // OOPIF 路径下也能收到正确的 false 信号（传 window.isFullScreen() 实查值）。
      nativeWindowFullscreenFromIPC = isFullscreen
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
    // fire-and-forget: re-prime warm cache on mount; same rationale as the module-load prime above.
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
