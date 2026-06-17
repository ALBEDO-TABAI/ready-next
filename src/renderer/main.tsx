// Temporal polyfill — must be injected BEFORE any Schedule-X code is loaded
// (even lazily), because SX v4 references Temporal at module init time.
import { Temporal } from '@js-temporal/polyfill'
if (!(globalThis as any).Temporal) {
  ;(globalThis as any).Temporal = Temporal
}

import React from 'react'
import ReactDOM, { type Root } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './styles/index.css'
import './styles/ritual-overlay.css'
import { writeStorage } from './utils/storage'

type StartupThemeSnapshot = {
  option: string
  resolved: 'light' | 'dark'
  skin: string
  isNativeFullscreen: boolean
}

let rendererRoot: Root | null = null

async function reconcileStartupTheme(): Promise<StartupThemeSnapshot | null> {
  if (!window.electronAPI) return null
  const themeResult = await window.electronAPI?.theme.get()
  if (!themeResult?.success || !themeResult.data) return null

  const { option, resolved, skin, isNativeFullscreen } = themeResult.data
  const root = document.documentElement

  // Main 进程是主题/皮肤的真值来源；localStorage 是 FOUC 兜底。这里把 stale localStorage 覆盖。
  writeStorage('ready-theme', option)
  if (
    skin === 'liquid-glass' ||
    skin === 'ready-glass' ||
    skin === 'solid-green-glass' ||
    skin === 'solid-blue-glass'
  ) {
    writeStorage('ready-theme-skin', skin)
  }

  // 同步四个 <html> attr：CSS selector
  //   html[data-native-fullscreen='true'][data-skin='liquid-glass'][data-glass-backdrop='native']
  // 同时依赖三个 attr，缺一不可。
  if (root.getAttribute('data-theme') !== resolved) {
    root.setAttribute('data-theme', resolved)
  }
  // data-skin 永远是 'liquid-glass'（与 useTheme.applySkin 行为一致，兼容现有 CSS）
  root.setAttribute('data-skin', 'liquid-glass')
  root.setAttribute(
    'data-glass-backdrop',
    skin === 'ready-glass' || skin === 'solid-green-glass' || skin === 'solid-blue-glass'
      ? 'ready'
      : 'native'
  )
  const variant =
    skin === 'solid-green-glass' ? 'solid-green' : skin === 'solid-blue-glass' ? 'solid-blue' : ''
  if (variant) root.setAttribute('data-glass-variant', variant)
  else root.removeAttribute('data-glass-variant')
  // 启动 reconciliation：data-native-fullscreen 只在 "纯原生窗口全屏"（IPC isNativeFullscreen=true）
  // 且当前**没有 HTML5 fullscreen 活跃**时设置。HTML5 fullscreen 期间不需要 .ready-app-bg backing
  // （iframe :fullscreen + ::backdrop 已经盖了一切），设了反而会因为 OOPIF 路径 IPC 不可靠卡死成黑屏。
  // App.tsx 的 useEffect 进一步用 `fullscreenchange` 事件保持同步。
  const htmlFullscreenActive = document.fullscreenElement !== null
  if (isNativeFullscreen && !htmlFullscreenActive) {
    root.setAttribute('data-native-fullscreen', 'true')
  } else {
    root.removeAttribute('data-native-fullscreen')
  }

  return { option, resolved, skin, isNativeFullscreen }
}

type AppComponent = React.ComponentType

function renderApp(App: AppComponent) {
  const root = rendererRoot
  if (!root) throw new Error('Renderer root is not initialized')
  root.render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>
  )
}

async function bootstrap() {
  const root = document.getElementById('root')
  if (!root) throw new Error('Root element #root not found')
  rendererRoot = ReactDOM.createRoot(root)

  if (window.location.hash.startsWith('#/startup-preview')) {
    const { default: StartupPreview } = await import('./pages/StartupPreview')
    renderApp(StartupPreview)
    return
  }

  const previewMode = new URLSearchParams(window.location.search).get('preview')
  if (previewMode === 'settings' && !(window as Window & { electronAPI?: unknown }).electronAPI) {
    const { installSettingsPreviewMocks } = await import('./preview/installSettingsPreviewMocks')
    installSettingsPreviewMocks()
  }

  await reconcileStartupTheme()

  const { default: App } = await import('./App')
  renderApp(App)
}

function renderFatalBootstrapError(error: unknown) {
  const root = document.getElementById('root')
  if (!root) return

  const message = error instanceof Error ? error.message : String(error)
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  const palette = isDark
    ? {
        bg: '#1A1B1E',
        card: '#202124',
        border: '#333538',
        text: '#D9DBE1',
        sub: '#8F96A3',
        preBg: '#1E1F22',
        preBorder: '#2A2B2E',
        err: '#F06060'
      }
    : {
        bg: '#f6f6f6',
        card: '#ffffff',
        border: '#e5e5e5',
        text: '#333',
        sub: '#666',
        preBg: '#fafafa',
        preBorder: '#eee',
        err: '#b42318'
      }
  root.innerHTML = `
    <div style="height:100vh;width:100vw;display:flex;align-items:center;justify-content:center;background:${palette.bg};color:${palette.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="max-width:640px;border:1px solid ${palette.border};border-radius:12px;background:${palette.card};padding:20px 22px;box-shadow:0 10px 24px rgba(0,0,0,0.06);">
        <div style="font-size:15px;font-weight:700;margin-bottom:8px;">Renderer bootstrap failed</div>
        <div style="font-size:12px;color:${palette.sub};margin-bottom:12px;">应用未能完成初始化，请重启应用或检查最近改动。</div>
        <pre style="margin:0;padding:10px;background:${palette.preBg};border:1px solid ${palette.preBorder};border-radius:8px;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;color:${palette.err};">${message}</pre>
      </div>
    </div>
  `
}

void bootstrap().catch((error) => {
  console.error('[renderer/bootstrap-fatal]', error)
  rendererRoot?.unmount()
  rendererRoot = null
  renderFatalBootstrapError(error)
})
