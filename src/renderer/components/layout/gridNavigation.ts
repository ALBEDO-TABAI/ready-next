export type GridNavigationEntry = string | null

export interface GridNavigationHistory {
  entries: GridNavigationEntry[]
  index: number
}

export function computeNextGridHistory(
  entries: GridNavigationEntry[],
  index: number,
  nextPath: GridNavigationEntry,
): GridNavigationHistory {
  const safeEntries = entries.length > 0 ? entries : [null]
  const safeIndex = Math.max(0, Math.min(index, safeEntries.length - 1))
  const currentPath = safeEntries[safeIndex] ?? null

  if (currentPath === nextPath) {
    return {
      entries: safeEntries,
      index: safeIndex,
    }
  }

  const nextEntries = safeEntries.slice(0, safeIndex + 1)
  nextEntries.push(nextPath)

  return {
    entries: nextEntries,
    index: nextEntries.length - 1,
  }
}
