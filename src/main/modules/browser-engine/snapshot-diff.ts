type Change = { path: (string | number)[]; value?: unknown; remove?: true }
const tokens = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4)

/** Exact structural patch, including all new target refs. Full payload wins if smaller. */
export function browserSnapshotDiff(previous: Record<string, unknown> | null, current: Record<string, unknown>): Record<string, unknown> {
  const changes: Change[] = []
  const walk = (before: unknown, after: unknown, path: (string | number)[]) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return
    if (before && after && typeof before === 'object' && typeof after === 'object'
      && !Array.isArray(before) && !Array.isArray(after)) {
      const left = before as Record<string, unknown>, right = after as Record<string, unknown>
      for (const key of Object.keys(left)) if (!(key in right)) changes.push({ path: [...path, key], remove: true })
      for (const [key, value] of Object.entries(right)) walk(left[key], value, [...path, key])
    } else changes.push({ path, value: after })
  }
  if (previous) walk(previous, current, [])
  const diff = { ok: true, observationFresh: current.observationFresh, pageIdentity: current.pageIdentity,
    snapshotDiff: { base: previous?.pageIdentity, changes } }
  const tokenComparison = { method: 'utf8_bytes_div_4_estimate', previous: previous ? tokens(previous) : 0,
    full: tokens(current), diff: previous ? tokens(diff) : null }
  return previous && current.observationFresh !== false && tokens(diff) < tokens(current) ? { ...diff, tokenComparison } : { ...current, tokenComparison }
}


const taskSnapshots = new WeakMap<object, Map<string, Map<string, Record<string, unknown>>>>()

export function taskBrowserSnapshotDiff(controller: object, taskId: string, tabId: string, current: Record<string, unknown>,
  registerCleanup?: (cleanup: () => void) => void): Record<string, unknown> {
  let tasks = taskSnapshots.get(controller)
  if (!tasks) { tasks = new Map(); taskSnapshots.set(controller, tasks) }
  let pages = tasks.get(taskId)
  if (!pages) {
    pages = new Map(); tasks.set(taskId, pages)
    registerCleanup?.(() => tasks.delete(taskId))
  }
  const result = browserSnapshotDiff(pages.get(tabId) || null, current)
  pages.set(tabId, structuredClone(current))
  return result
}
