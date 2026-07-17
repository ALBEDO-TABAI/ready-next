const boardIdsByTabId = new Map<string, string>()
const pendingSavesByPath = new Map<string, Promise<void>>()

export function rememberBoardHandle(tabId: string, boardId: string): void {
  boardIdsByTabId.set(tabId, boardId)
}

export async function releaseClosedBoardHandles(
  openTabIds: ReadonlySet<string>,
  clearActive: (expectedBoardId: string) => Promise<unknown> | unknown,
): Promise<void> {
  const closedBoardIds: string[] = []
  for (const [tabId, boardId] of boardIdsByTabId) {
    if (openTabIds.has(tabId)) continue
    boardIdsByTabId.delete(tabId)
    closedBoardIds.push(boardId)
  }
  await Promise.allSettled(closedBoardIds.map((boardId) => Promise.resolve().then(() => clearActive(boardId))))
}

export function trackBoardPathSave(path: string, save: Promise<void>): Promise<void> {
  const previous = pendingSavesByPath.get(path) ?? Promise.resolve()
  const tracked = previous.catch(() => undefined).then(() => save)
  pendingSavesByPath.set(path, tracked)
  void tracked.finally(() => {
    if (pendingSavesByPath.get(path) === tracked) pendingSavesByPath.delete(path)
  }).catch(() => undefined)
  return tracked
}

export async function waitForBoardPathSave(path: string): Promise<void> {
  await pendingSavesByPath.get(path)
}

export async function waitForAllBoardPathSaves(): Promise<void> {
  await Promise.allSettled([...pendingSavesByPath.values()])
}

export function resetBoardHandleRegistryForTests(): void {
  boardIdsByTabId.clear()
  pendingSavesByPath.clear()
}
