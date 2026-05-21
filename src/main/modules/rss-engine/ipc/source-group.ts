// Stage V V2.2a — rss-engine SourceGroup channel cluster.
//
// Bundles the 4 channels that drive RSS source CRUD + the draft-store
// projection used by the renderer's source list:
//
//   rss:getSources             (list all sources, renderer-shaped)
//   rss:addSource              (validate URL → detect platform → initial
//                               fetch → DB persist → diagnostics record)
//   rss:removeSource           (drop a source by id)
//   rss:getDraftStoreSources   (list sources with their stored/inbox/star
//                               counts for the draft-store tab)
//
// Handler bodies are lifted from `ipc-handler.ts` (V2.2a is a move +
// thin-wrapper: response shaping and mock-mode dispatch stay on this
// side; the host-owned pipeline behind `addSource` runs through
// `EngineDeps.addSourceCore` so the group does not import the scraper /
// rsshub-manager / browser-controller chain).
//
// The 4 channels live in one group despite ranging across reads
// (`getSources`, `getDraftStoreSources`) and mutations (`addSource`,
// `removeSource`) because they share:
//   • the same domain concept (rss source lifecycle)
//   • the same dispose lifecycle (renderer wires them together)
//   • the same dep surface (repository + mock flag + the addSource core)
// Splitting reads from writes would create two groups whose deps overlap
// entirely, which goes against the per-group-deps-as-contract intent.
import type { IpcMain } from 'electron'
import type { EngineDeps } from './engine-deps'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps — subset of `EngineDeps`. Tests pass a fake that
 * implements exactly these six members; nothing more is required to
 * exercise the 4 handler bodies.
 */
export type SourceGroupDeps = Pick<
  EngineDeps,
  | 'useMock'
  | 'getRSSRepository'
  | 'mapSourceToAPI'
  | 'mapDraftStoreSourceToAPI'
  | 'addSourceCore'
  | 'mockSources'
>

const CHANNELS = [
  'rss:getSources',
  'rss:addSource',
  'rss:removeSource',
  'rss:getDraftStoreSources',
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

export const sourceGroup: IpcChannelGroup<SourceGroupDeps> = {
  namespace: 'rss:source',

  register(ipcMain: IpcMain, deps: SourceGroupDeps): IpcDisposeHandle {
    // setupRSSIPC may be re-entered on dev reload; strip any prior handler
    // so `ipcMain.handle` does not throw on the second registration. Mirrors
    // the pre-extraction defensive pattern used elsewhere in the host.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('rss:getSources', async () => {
      if (deps.useMock) return ok(deps.mockSources, true)
      try {
        const repo = deps.getRSSRepository()
        const sources = repo.getRSSSources() as unknown[]
        return ok(sources.map((source) => deps.mapSourceToAPI(source)), false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle('rss:addSource', async (_event, source: { name?: string; url: string; group?: string }) => {
      if (deps.useMock) {
        return ok({ id: `source-${Date.now()}`, platform: 'rss', itemCount: 0 }, true)
      }
      try {
        const result = await deps.addSourceCore({
          name: source.name,
          url: source.url,
          group: source.group,
        })
        if (!result.ok) return fail(result.error)
        return ok(result.data, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle('rss:removeSource', async (_event, id: string) => {
      if (deps.useMock) return ok({ removed: true }, true)
      try {
        deps.getRSSRepository().removeRSSSource(id)
        return ok({ removed: true }, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle('rss:getDraftStoreSources', async () => {
      if (deps.useMock) return ok([], true)
      try {
        const sources = deps.getRSSRepository().getRSSDraftStoreSources()
        return ok(sources.map((source) => deps.mapDraftStoreSourceToAPI(source)), false)
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
export const _sourceGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
