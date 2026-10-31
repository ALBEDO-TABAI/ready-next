import { returnFromReference, useReferenceReturn } from './reference-return'
import type { WorkbenchMode } from '../../stores/useMode'

export function ReferenceReturnCapsule({ mode }: { mode: WorkbenchMode }) {
  const { entry, destination } = useReferenceReturn()
  // Keep DOM controls out of the native BrowserView, including split panes. Document mode shows it in its tab bar.
  if (!entry || mode === 'browser' || mode === 'document' || mode !== destination) return null
  return <button type="button" className="ready-glass-button" aria-label={`返回 ${entry.label}`} onClick={returnFromReference}
    style={{ position: 'absolute', right: 16, top: 8, zIndex: 30, borderRadius: 999, padding: '6px 14px', background: 'var(--surface-panel-bg)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-sm)' }}>← 返回 {entry.label}</button>
}
