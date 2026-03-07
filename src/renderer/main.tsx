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

async function bootstrap() {
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
  root.innerHTML = `
    <div style="height:100vh;width:100vw;display:flex;align-items:center;justify-content:center;background:#f6f6f6;color:#333;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="max-width:640px;border:1px solid #e5e5e5;border-radius:12px;background:#fff;padding:20px 22px;box-shadow:0 10px 24px rgba(0,0,0,0.06);">
        <div style="font-size:15px;font-weight:700;margin-bottom:8px;">Renderer bootstrap failed</div>
        <div style="font-size:12px;color:#666;margin-bottom:12px;">应用未能完成初始化，请重启应用或检查最近改动。</div>
        <pre style="margin:0;padding:10px;background:#fafafa;border:1px solid #eee;border-radius:8px;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;color:#b42318;">${message}</pre>
      </div>
    </div>
  `
}

void bootstrap().catch((error) => {
  console.error('[renderer/bootstrap-fatal]', error)
  renderFatalBootstrapError(error)
})
