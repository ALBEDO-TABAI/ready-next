// RSS item mutations. Shared list reads live in content-group.
import type { IpcMain } from 'electron'
import type { EngineDeps } from './engine-deps'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps — subset of `EngineDeps`. Tests pass a fake that
 * implements the mutation repository and mock flag; nothing more is required to
 * exercise the 5 handler bodies.
 */
export type ItemGroupDeps = Pick<
  EngineDeps,
  | 'useMock'
  | 'getRSSRepository'
>

const CHANNELS = [
  'rss:markRead',
  'rss:markReadBatch',
  'rss:deleteItems',
  'rss:toggleStarred',
  'rss:clearDraftStore',
] as const

interface RSSResponse<T> {
  success: boolean
  mock: boolean
  data?: T
  error?: string
}

function ok<T>(data: T, isMock: boolean): RSSResponse<T> {
  return { success: true, mock: isMock, data }
}

function fail(error: string): RSSResponse<never> {
  return { success: false, mock: false, error }
}

export const itemGroup: IpcChannelGroup<ItemGroupDeps> = {
  namespace: 'rss:item',

  register(ipcMain: IpcMain, deps: ItemGroupDeps): IpcDisposeHandle {
    // setupRSSIPC may be re-entered on dev reload; strip any prior handler
    // so `ipcMain.handle` does not throw on the second registration. Mirrors
    // SourceGroup's defensive pre-clear and the host's pre-extraction
    // pattern.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('rss:markRead', async (_event, itemId: string) => {
      if (deps.useMock) return ok({ marked: true }, true)
      try {
        deps.getRSSRepository().markRSSRead(itemId)
        return ok({ marked: true }, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle('rss:markReadBatch', async (_event, itemIds: string[]) => {
      if (deps.useMock) return ok({ marked: itemIds.length }, true)
      try {
        const marked = deps.getRSSRepository().markRSSReadMany(itemIds)
        // Preserve the pre-extraction batch-trace log — the host's
        // `[rss:batch]` log channel is consumed by debug overlays. Drop or
        // rename would silently break those.
        console.log(`[rss:batch] markReadBatch size=${itemIds.length} marked=${marked}`)
        return ok({ marked }, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle(
      'rss:deleteItems',
      async (
        _event,
        payload: string[] | { itemIds: string[]; preserveStarred?: boolean },
      ) => {
        const itemIds = Array.isArray(payload) ? payload : payload?.itemIds ?? []
        const preserveStarred = Array.isArray(payload) ? false : payload?.preserveStarred === true
        if (deps.useMock) return ok({ deleted: itemIds.length }, true)
        try {
          const dismissed = deps.getRSSRepository().dismissRSSItemsFromInbox(itemIds, preserveStarred)
          console.log(
            `[rss:batch] deleteItems size=${itemIds.length} dismissed=${dismissed} preserveStarred=${preserveStarred}`,
          )
          return ok({ deleted: dismissed, dismissed }, false)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      },
    )

    ipcMain.handle('rss:toggleStarred', async (_event, itemId: string) => {
      if (deps.useMock) return ok({ toggled: true }, true)
      try {
        deps.getRSSRepository().toggleRSSStarred(itemId)
        return ok({ toggled: true }, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle('rss:clearDraftStore', async (_event, payload?: { sourceId?: string }) => {
      if (deps.useMock) {
        return ok({ deletedItems: 0, resetSources: payload?.sourceId ? 1 : 0 }, true)
      }
      try {
        const result = deps.getRSSRepository().clearRSSDraftStore(payload?.sourceId?.trim() || undefined)
        return ok(result, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already removed */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertion). */
export const _itemGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
