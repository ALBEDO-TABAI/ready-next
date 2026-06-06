export interface FileTreeSelectionState {
  selectedPaths: ReadonlySet<string>
  anchorPath: string | null
}

export interface FileTreeSelectionClick {
  path: string
  orderedPaths: readonly string[]
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
}

export interface FileTreeSelectionResult {
  selectedPaths: Set<string>
  anchorPath: string | null
}

export interface FileTreeDeleteTarget {
  path: string
  name: string
}

function getRangePaths(orderedPaths: readonly string[], fromPath: string, toPath: string): string[] {
  const fromIndex = orderedPaths.indexOf(fromPath)
  const toIndex = orderedPaths.indexOf(toPath)
  if (fromIndex === -1 || toIndex === -1) return [toPath]
  const start = Math.min(fromIndex, toIndex)
  const end = Math.max(fromIndex, toIndex)
  return orderedPaths.slice(start, end + 1)
}

export function computeNextFileTreeSelection(
  state: FileTreeSelectionState,
  click: FileTreeSelectionClick,
): FileTreeSelectionResult {
  const additive = Boolean(click.metaKey || click.ctrlKey)
  const range = Boolean(click.shiftKey)

  if (range) {
    const anchorPath = state.anchorPath && click.orderedPaths.includes(state.anchorPath)
      ? state.anchorPath
      : click.path
    const rangePaths = getRangePaths(click.orderedPaths, anchorPath, click.path)
    const selectedPaths = additive ? new Set(state.selectedPaths) : new Set<string>()
    for (const path of rangePaths) selectedPaths.add(path)
    return { selectedPaths, anchorPath }
  }

  if (additive) {
    const selectedPaths = new Set(state.selectedPaths)
    if (selectedPaths.has(click.path)) selectedPaths.delete(click.path)
    else selectedPaths.add(click.path)
    return { selectedPaths, anchorPath: click.path }
  }

  return {
    selectedPaths: new Set([click.path]),
    anchorPath: click.path,
  }
}

function isDescendantPath(path: string, ancestor: string): boolean {
  return path.startsWith(`${ancestor}/`) || path.startsWith(`${ancestor}\\`)
}

export function compactFileTreeDeleteTargets(targets: readonly FileTreeDeleteTarget[]): FileTreeDeleteTarget[] {
  const uniqueTargets = [...new Map(targets.map((target) => [target.path, target])).values()]
  return uniqueTargets
    .sort((a, b) => a.path.length - b.path.length)
    .filter((target, index, sorted) =>
      !sorted.slice(0, index).some((candidate) => isDescendantPath(target.path, candidate.path)),
    )
}
