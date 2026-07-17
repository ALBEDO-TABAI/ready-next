/**
 * EP2 dogfood gap 4 — tool writes into workspace directories must surface in
 * the file tree immediately. The watch-group only watches directories the
 * renderer has expanded; a batch download into a collapsed folder produces no
 * fs.watch event the renderer ever sees. This helper broadcasts the SAME
 * `document:directoryChanged` push to every live renderer window so the tree
 * invalidates the target directory right after a tool write. BrowserViews,
 * DevTools and workers do not own the file tree and must not receive it.
 *
 * The Main composition root injects the workbench webContents explicitly;
 * enumerating BrowserWindow would also include native overlay helper windows.
 */

import { recordDocumentPerformanceCounter } from '../../../../shared/document-performance-diagnostics'

type WebContentsLike = {
  id?: number
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
  once?(event: 'destroyed', listener: () => void): void
}

type PendingDirectoryChange = {
  sender: WebContentsLike
  paths: Set<string>
  timer: NodeJS.Timeout
}

const DEFAULT_BROADCAST_DEBOUNCE_MS = 140
const pendingBySender = new Map<number | WebContentsLike, PendingDirectoryChange>()
const destroyCleanupRegistered = new WeakSet<WebContentsLike>()

let targetProvider: (() => WebContentsLike[]) | null = null

export function setDirectoryChangeBroadcastTargetProvider(provider: (() => WebContentsLike[]) | null): void {
  targetProvider = provider
}

export function __setWebContentsProviderForTests(provider: (() => WebContentsLike[]) | null): void {
  setDirectoryChangeBroadcastTargetProvider(provider)
}

function liveWebContents(): WebContentsLike[] {
  return targetProvider?.() ?? []
}

function senderKey(sender: WebContentsLike): number | WebContentsLike {
  return typeof sender.id === 'number' ? sender.id : sender
}

function flushPendingDirectoryChange(key: number | WebContentsLike): boolean {
  const pending = pendingBySender.get(key)
  if (!pending) return false
  pendingBySender.delete(key)
  clearTimeout(pending.timer)

  const paths = Array.from(pending.paths)
  if (paths.length === 0 || pending.sender.isDestroyed()) return false
  try {
    pending.sender.send('document:directoryChanged', { paths, timestamp: Date.now() })
    recordDocumentPerformanceCounter('directoryBroadcasts')
    return true
  } catch {
    return false
  }
}

/**
 * Queue one coalesced push for a specific renderer. Watch notifications and
 * direct mutation notifications share this path so the renderer observes one
 * path set instead of two competing event streams.
 */
export function queueDirectoryChanged(
  sender: WebContentsLike,
  paths: ReadonlyArray<string>,
  debounceMs = DEFAULT_BROADCAST_DEBOUNCE_MS,
): boolean {
  if (sender.isDestroyed()) return false
  const normalized = paths.map((path) => String(path || '').trim()).filter(Boolean)
  if (normalized.length === 0) return false

  const key = senderKey(sender)
  if (sender.once && !destroyCleanupRegistered.has(sender)) {
    destroyCleanupRegistered.add(sender)
    sender.once('destroyed', () => cancelDirectoryChangeBroadcast(sender))
  }
  const existing = pendingBySender.get(key)
  if (existing) {
    normalized.forEach((path) => existing.paths.add(path))
    return true
  }

  const timer = setTimeout(() => {
    flushPendingDirectoryChange(key)
  }, Math.max(0, debounceMs))
  timer.unref?.()
  pendingBySender.set(key, {
    sender,
    paths: new Set(normalized),
    timer,
  })
  return true
}

/** Returns the number of live webContents queued (0 outside Electron — harmless). */
export function broadcastDirectoryChanged(paths: ReadonlyArray<string>): number {
  let queued = 0
  for (const sender of liveWebContents()) {
    try {
      if (queueDirectoryChanged(sender, paths)) queued += 1
    } catch { /* a dying webContents must not break the download result */ }
  }
  return queued
}

export function cancelDirectoryChangeBroadcast(sender: WebContentsLike): void {
  const key = senderKey(sender)
  const pending = pendingBySender.get(key)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingBySender.delete(key)
}

export function flushDirectoryChangeBroadcastsForTests(): number {
  let sent = 0
  for (const key of Array.from(pendingBySender.keys())) {
    if (flushPendingDirectoryChange(key)) sent += 1
  }
  return sent
}

export function resetDirectoryChangeBroadcastsForTests(): void {
  shutdownDirectoryChangeBroadcasts()
}

export function shutdownDirectoryChangeBroadcasts(): void {
  for (const pending of pendingBySender.values()) clearTimeout(pending.timer)
  pendingBySender.clear()
}
