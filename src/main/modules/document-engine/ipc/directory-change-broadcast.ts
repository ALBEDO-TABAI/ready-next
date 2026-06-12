/**
 * EP2 dogfood gap 4 — tool writes into workspace directories must surface in
 * the file tree immediately. The watch-group only watches directories the
 * renderer has expanded; a batch download into a collapsed folder produces no
 * fs.watch event the renderer ever sees. This helper broadcasts the SAME
 * `document:directoryChanged` push to every live webContents so the tree
 * invalidates the target directory right after a tool write.
 *
 * Electron is imported lazily via createRequire (database.ts/roots.ts
 * paradigm) — host-node test chains reach this module through browser-tools.
 */

import { createRequire } from 'node:module'

type WebContentsLike = { isDestroyed(): boolean; send(channel: string, payload: unknown): void }

let testProvider: (() => WebContentsLike[]) | null = null

export function __setWebContentsProviderForTests(provider: (() => WebContentsLike[]) | null): void {
  testProvider = provider
}

function liveWebContents(): WebContentsLike[] {
  if (testProvider) return testProvider()
  try {
    const electron = createRequire(import.meta.url)('electron') as typeof import('electron') | string
    if (typeof electron === 'string' || !electron.webContents) return []
    return electron.webContents.getAllWebContents() as unknown as WebContentsLike[]
  } catch {
    return []
  }
}

/** Returns the number of webContents notified (0 outside Electron — harmless). */
export function broadcastDirectoryChanged(paths: ReadonlyArray<string>): number {
  const normalized = paths.map((path) => String(path || '').trim()).filter(Boolean)
  if (normalized.length === 0) return 0
  let notified = 0
  for (const contents of liveWebContents()) {
    try {
      if (contents.isDestroyed()) continue
      contents.send('document:directoryChanged', { paths: normalized, timestamp: Date.now() })
      notified += 1
    } catch { /* a dying webContents must not break the download result */ }
  }
  return notified
}
