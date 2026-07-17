import type { RegisterDormantBrowserTabsResult } from '../../../shared/browser-tab-session'

export function selectAcceptedDormantTabs<T extends { id: string }>(
  persistedTabs: T[],
  result: RegisterDormantBrowserTabsResult,
): T[] {
  const acceptedIds = new Set([
    ...(result.materializedTabIds ?? []),
    ...(result.dormantTabIds ?? []),
  ])
  const recovered: T[] = []
  const seen = new Set<string>()
  for (const tab of persistedTabs) {
    if (!acceptedIds.has(tab.id) || seen.has(tab.id)) continue
    seen.add(tab.id)
    recovered.push(tab)
  }
  return recovered
}
