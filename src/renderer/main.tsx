// Temporal polyfill — must be injected BEFORE any Schedule-X code is loaded
// (even lazily), because SX v4 references Temporal at module init time.
import { Temporal } from '@js-temporal/polyfill'
if (!(globalThis as any).Temporal) {
  ;(globalThis as any).Temporal = Temporal
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './styles/index.css'
import './styles/ritual-overlay.css'
import { writeStorage } from './utils/storage'

async function reconcileStartupTheme() {
  if (!window.electronAPI) return
  const themeResult = await window.electronAPI?.theme.get()
  if (!themeResult?.success || !themeResult.data) return

  writeStorage('ready-theme', themeResult.data.option)
  const root = document.documentElement
  if (root.getAttribute('data-theme') !== themeResult.data.resolved) {
    root.setAttribute('data-theme', themeResult.data.resolved)
  }
}

async function bootstrap() {
  const previewMode = new URLSearchParams(window.location.search).get('preview')
  if (previewMode === 'settings' && !(window as Window & { electronAPI?: unknown }).electronAPI) {
    const { installSettingsPreviewMocks } = await import('./preview/installSettingsPreviewMocks')
    installSettingsPreviewMocks()
  }

  await reconcileStartupTheme()

  const { default: App } = await import('./App')
  const root = document.getElementById('root')
  if (!root) throw new Error('Root element #root not found')

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>
  )

}

function renderFatalBootstrapError(error: unknown) {
  const root = document.getElementById('root')
  if (!root) return

  const message = error instanceof Error ? error.message : String(error)
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  const palette = isDark
    ? { bg: '#1A1B1E', card: '#202124', border: '#333538', text: '#D9DBE1', sub: '#8F96A3', preBg: '#1E1F22', preBorder: '#2A2B2E', err: '#F06060' }
    : { bg: '#f6f6f6', card: '#ffffff', border: '#e5e5e5', text: '#333',    sub: '#666',    preBg: '#fafafa', preBorder: '#eee',    err: '#b42318' }
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
  renderFatalBootstrapError(error)
})
