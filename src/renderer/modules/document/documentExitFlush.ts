import { drafts } from './drafts/runtime'
import { RENDERER_STATE_FLUSH_TIMEOUT_MS } from '../../../shared/renderer-state-flush'
import {
  flushPendingDocTabPersistenceForExit,
  useDocTabs,
  type DocTab,
} from '../../stores/useDocTabs'
import {
  getDocumentSaveSerializationKey,
  runSerializedDocumentSave,
} from './documentSaveRegistry'

export interface DocumentExitFlushPort {
  getTabs(): DocTab[]
  runSerialized<T>(tabId: string, path: string, operation: () => Promise<T>): Promise<T>
  writeFile(path: string, content: string): Promise<{ success?: boolean; error?: string }>
  commitTabSaveSnapshot(tabId: string, expectedContent: string, writtenContent: string): boolean
  flushDraftPersistence(): Promise<void> | void
  now(): number
}

interface DocumentExitFlushOptions {
  timeoutMs?: number
  maxPasses?: number
}

const EXIT_FLUSH_SAFETY_MARGIN_MS = 250

function dirtyPathTabs(tabs: DocTab[]): DocTab[] {
  return tabs.filter((tab) => tab.isDirty && Boolean(tab.path))
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function flushDirtyTabs(
  port: DocumentExitFlushPort,
  options: DocumentExitFlushOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? RENDERER_STATE_FLUSH_TIMEOUT_MS - EXIT_FLUSH_SAFETY_MARGIN_MS
  const maxPasses = options.maxPasses ?? 50
  const startedAt = port.now()

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let draftError: unknown = null
    try {
      await port.flushDraftPersistence()
    } catch (error) {
      // silent-catch: retain this failure and report it after every independent path write has been attempted.
      draftError = error
    }
    const tabIds = dirtyPathTabs(port.getTabs()).map((tab) => tab.id)
    if (tabIds.length === 0 && !draftError) return

    const results = await Promise.allSettled(tabIds.map(async (tabId) => {
      const queuedTab = port.getTabs().find((candidate) => candidate.id === tabId)
      if (!queuedTab?.isDirty || !queuedTab.path) return
      const queuedPath = queuedTab.path
      await port.runSerialized(tabId, queuedPath, async () => {
        if (port.now() - startedAt >= timeoutMs) throw new Error('退出前保存超时，已取消关闭以保留最新内容')
        const tab = port.getTabs().find((candidate) => candidate.id === tabId)
        if (!tab?.isDirty || tab.path !== queuedPath) return
        const snapshot = tab.content
        const result = await port.writeFile(queuedPath, snapshot)
        if (!result.success) {
          throw new Error(`${tab.title || queuedPath}: ${result.error || '文档保存失败'}`)
        }
        port.commitTabSaveSnapshot(tab.id, snapshot, snapshot)
      })
    }))
    try {
      await port.flushDraftPersistence()
      draftError = null
    } catch (error) {
      // silent-catch: retain the final draft failure and aggregate it with any path write failures below.
      draftError = error
    }
    const errors = [
      ...results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      ...(draftError ? [draftError] : []),
    ]
    if (errors.length > 0) {
      throw new AggregateError(errors, errors.map(describeError).join('；'))
    }

    if (dirtyPathTabs(port.getTabs()).length === 0) return
    if (port.now() - startedAt >= timeoutMs) {
      throw new Error('退出前文档仍在持续变化，已取消关闭以保留最新内容')
    }
  }

  throw new Error('退出前文档持续变化次数过多，已取消关闭以保留最新内容')
}

export async function flushDirtyDocumentTabsForExit(
  port: DocumentExitFlushPort,
  options: DocumentExitFlushOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? RENDERER_STATE_FLUSH_TIMEOUT_MS - EXIT_FLUSH_SAFETY_MARGIN_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      flushDirtyTabs(port, { ...options, timeoutMs }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('退出前保存超时，已取消关闭以保留最新内容')), timeoutMs)
      }),
    ])
  } finally { clearTimeout(timer) }
}

export async function flushCurrentDocumentTabsForExit(): Promise<void> {
  await flushDirtyDocumentTabsForExit({
    getTabs: () => useDocTabs.getState().tabs,
    runSerialized: (tabId, path, operation) => runSerializedDocumentSave(
      getDocumentSaveSerializationKey(tabId, path),
      operation,
    ),
    writeFile: async (path, content) => {
      const api = window.electronAPI?.document
      if (!api) return { success: false, error: '文档保存服务不可用' }
      const tab = useDocTabs.getState().tabs.find(tab => tab.path === path && tab.isDirty)
      if (tab && drafts.status(tab.id)?.conflict) return { success: false, error: '磁盘版本已变化，请先处理草稿冲突' }
      return api.writeFile(path, content)
    },
    commitTabSaveSnapshot: (tabId, expectedContent, writtenContent) => (
      useDocTabs.getState().commitTabSaveSnapshot(tabId, expectedContent, writtenContent)
    ),
    flushDraftPersistence: flushPendingDocTabPersistenceForExit,
    now: () => Date.now(),
  })
}
