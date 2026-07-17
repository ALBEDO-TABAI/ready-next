export interface BrowserPageMapAmbiguityGroup {
  role: string
  name: string
  targetIds: string[]
}

const ambiguityByTab = new Map<string, Map<string, BrowserPageMapAmbiguityGroup>>()

export function rememberBrowserPageMapAmbiguity(
  tabId: string,
  groups: BrowserPageMapAmbiguityGroup[],
): void {
  const byTarget = new Map<string, BrowserPageMapAmbiguityGroup>()
  for (const group of groups) {
    for (const targetId of group.targetIds) byTarget.set(targetId, group)
  }
  ambiguityByTab.set(tabId, byTarget)
}

export function getBrowserPageMapAmbiguity(
  tabId: string,
  targetId: string,
): BrowserPageMapAmbiguityGroup | null {
  return ambiguityByTab.get(tabId)?.get(targetId) ?? null
}

export function disposeBrowserPageMapAmbiguity(tabId: string): void {
  ambiguityByTab.delete(tabId)
}

export function resetBrowserPageMapAmbiguityForTests(): void {
  ambiguityByTab.clear()
}
