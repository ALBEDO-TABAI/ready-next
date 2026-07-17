const boardIdsByTabId = new Map<string, string>()
interface BoardPathSaveEntry {
  promise: Promise<void>
  retry?: () => Promise<void>
}

const pendingSavesByPath = new Map<string, BoardPathSaveEntry>()

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

export function trackBoardPathSave(
  path: string,
  save: Promise<void>,
  retry?: () => Promise<void>,
): Promise<void> {
  const previous = pendingSavesByPath.get(path)?.promise ?? Promise.resolve()
  const tracked = previous.catch(() => undefined).then(() => save)
  const entry = { promise: tracked, retry }
  pendingSavesByPath.set(path, entry)
  void tracked.then(
    () => {
      if (pendingSavesByPath.get(path) === entry) pendingSavesByPath.delete(path)
    },
    () => undefined,
  )
  return tracked
}

export async function waitForBoardPathSave(path: string): Promise<void> {
  await pendingSavesByPath.get(path)?.promise
}

export async function retryBoardPathSave(path: string): Promise<void> {
  const entry = pendingSavesByPath.get(path)
  if (!entry) return
  try {
    await entry.promise
    return
  } catch {
    // silent-catch: the rejected save is the prerequisite for retrying its retained snapshot.
  }
  if (!entry.retry) throw new Error('该画板没有可用的保存重试')
  const retry = entry.retry
  await trackBoardPathSave(path, Promise.resolve().then(retry), retry)
}

export async function waitForAllBoardPathSaves(): Promise<void> {
  const results = await Promise.allSettled([...pendingSavesByPath.values()].map((entry) => entry.promise))
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length > 0) throw new AggregateError(errors, '一个或多个画板未能保存')
}

export function resetBoardHandleRegistryForTests(): void {
  boardIdsByTabId.clear()
  pendingSavesByPath.clear()
}
