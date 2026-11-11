import { navigateBack, useNavigationHistory } from './navigation-history'
import type { WorkbenchMode } from '../../stores/useMode'

export function ReferenceReturnCapsule({ mode }: { mode: WorkbenchMode }) {
  const { canBack, backTitle } = useNavigationHistory()
  // Keep DOM controls out of the native BrowserView, including split panes. Document mode shows it in its tab bar.
  if (!canBack || mode === 'browser' || mode === 'document') return null
  return <button type="button" className="ready-glass-button" aria-label={`返回 ${backTitle}`} onClick={() => { void navigateBack().catch(error => console.error('[navigation] back failed', error)) }}
    style={{ position: 'absolute', right: 16, top: 8, zIndex: 30, borderRadius: 999, padding: '6px 14px', background: 'var(--surface-panel-bg)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-sm)' }}>← 返回 {backTitle}</button>
}
