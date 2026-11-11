// Main keeps one watched-directory set per window (document:watchDirectories replaces it, non-recursively). Several
// views need watching at once: the file view its expanded folders, an open database its row folder. Each owner
// states its folders here and Main receives the union, so one owner never unwatches another's.

const owners = new Map<symbol, readonly string[]>()
let sent: string | null = null

function sync(): void {
  const union = [...new Set([...owners.values()].flat())].sort()
  const key = union.join('\0')
  if (key === sent) return
  sent = key
  // fire-and-forget: Main reconciles the whole set on every call, so a dropped call is corrected by the next one.
  void window.electronAPI?.document?.watchDirectories?.(union)?.catch(() => undefined)
}

export function watchDirectoriesFor(owner: symbol, paths: readonly string[]): void {
  if (paths.length) owners.set(owner, paths)
  else owners.delete(owner)
  sync()
}

export function releaseDirectoryWatch(owner: symbol): void {
  owners.delete(owner)
  sync()
}

export function resetDirectoryWatchRegistryForTests(): void {
  owners.clear()
  sent = null
}
