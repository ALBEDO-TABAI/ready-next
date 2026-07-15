interface FileEmergenceTabState {
  tabs: ReadonlyArray<{
    id: string
    path: string | null
    title: string
    content: string
    isDirty: boolean
    lastActivatedAt?: number | null
    groupId?: string | null
  }>
  tabGroups: ReadonlyArray<{
    id: string
    name: string
  }>
  activeTabId: string
  splitTabId: string | null
}

export interface FileEmergenceProjectContext {
  tabGroups: Array<{ name: string; paths: string[] }>
}

export interface FileEmergenceDocumentState {
  tabs: Array<{
    id: string
    path: string | null
    title: string
    isDirty: boolean
    lastActivatedAt: number | null
  }>
  activeTabId: string
  splitTabId: string | null
}

export function selectFileEmergenceProjectContextSignature(
  state: FileEmergenceTabState,
): string {
  return JSON.stringify({
    tabGroups: state.tabGroups
      .map((group) => ({
        name: group.name.trim(),
        paths: state.tabs
          .filter((tab) => tab.groupId === group.id && tab.path)
          .map((tab) => tab.path!),
      }))
      .filter((group) => group.name.length > 0 && group.paths.length >= 2),
  } satisfies FileEmergenceProjectContext)
}

export function readFileEmergenceProjectContextSignature(
  signature: string,
): FileEmergenceProjectContext {
  return JSON.parse(signature) as FileEmergenceProjectContext
}

export function selectFileEmergenceDocumentStateSignature(
  state: FileEmergenceTabState,
): string {
  return JSON.stringify({
    tabs: state.tabs.map((tab) => ({
      id: tab.id,
      path: tab.path,
      title: tab.title,
      isDirty: tab.isDirty,
      lastActivatedAt: Number.isFinite(tab.lastActivatedAt) ? Number(tab.lastActivatedAt) : null,
    })),
    activeTabId: state.activeTabId,
    splitTabId: state.splitTabId,
  } satisfies FileEmergenceDocumentState)
}

export function readFileEmergenceDocumentStateSignature(
  signature: string,
): FileEmergenceDocumentState {
  return JSON.parse(signature) as FileEmergenceDocumentState
}
