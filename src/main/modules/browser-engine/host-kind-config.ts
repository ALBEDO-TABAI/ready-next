import type { BrowserHostKind } from './host-types'

export function resolveBrowserHostKindFromConfig(
  envRaw: string | undefined,
  readStoredDriver: () => unknown,
): BrowserHostKind {
  const normalizedEnv = typeof envRaw === 'string' ? envRaw.trim().toLowerCase() : ''
  if (normalizedEnv === 'browserview') return 'browserView'
  if (normalizedEnv === 'webcontentsview') return 'webContentsView'
  try {
    const raw = String(readStoredDriver() || '').trim().toLowerCase()
    if (raw === 'browserview') return 'browserView'
    if (raw === 'webcontentsview') return 'webContentsView'
  } catch {
    // ignore persisted setting failures
  }
  return 'webContentsView'
}
