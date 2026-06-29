export interface ActiveTabPairOrderItem<T> {
  tab: T
  sourceIndex: number
}

export function getActiveTabPairOrder<T extends { id: string }>(
  tabs: T[],
  activeTabId: string | null,
  secondaryTabId: string | null,
): ActiveTabPairOrderItem<T>[] {
  const baseOrder = tabs.map((tab, sourceIndex) => ({ tab, sourceIndex }))
  if (!activeTabId || !secondaryTabId || activeTabId === secondaryTabId) return baseOrder

  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId)
  const secondaryIndex = tabs.findIndex((tab) => tab.id === secondaryTabId)
  if (activeIndex < 0 || secondaryIndex < 0) return baseOrder

  const secondaryTab = tabs[secondaryIndex]
  if (!secondaryTab) return baseOrder

  const ordered: ActiveTabPairOrderItem<T>[] = []
  for (let sourceIndex = 0; sourceIndex < tabs.length; sourceIndex += 1) {
    const tab = tabs[sourceIndex]
    if (!tab || tab.id === secondaryTabId) continue
    ordered.push({ tab, sourceIndex })
    if (tab.id === activeTabId) {
      ordered.push({ tab: secondaryTab, sourceIndex: secondaryIndex })
    }
  }

  return ordered
}
