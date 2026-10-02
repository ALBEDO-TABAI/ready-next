// Stage V V2.2f — rss-engine ExportGroup channel cluster (final rss-engine
// group; closes out the V2.2 split).
//
// Bundles the 2 channels that materialise rss-engine artifacts to disk for
// the renderer's "Export" surface:
//
//   rss:exportOpml   (regenerates `subscriptions.opml` under the artifacts
//                     root and returns its absolute path — the renderer
//                     hands the path to the OS shell to reveal/open)
//   rss:exportFeed   (regenerates the full RSS artifact bundle and returns
//                     the absolute path of the requested feed file — the
//                     master `feed.xml` by default, or one of the category
//                     feeds keyed by `'tech' | 'humanities' | 'design' |
//                     'entertainment' | 'others'`)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.2f follows
// the V2.2a–e move + thin-wrapper shape). The handlers do NOT import any
// rss-engine internals directly: the artifact-bundle generator and the
// artifacts-root accessor are injected via `ExportGroupDeps` so the group
// is testable in isolation and so a future move out of rss-engine stays
// mechanical. `joinPath` is injected too so the mock-mode branch can
// compose the placeholder paths without importing `node:path`.
//
// The 2 channels live in one group despite returning paths of different
// kinds (one opml, one feed.xml/category-feed) because they share:
//   • the same domain concept (export an artifact bundle, return a path)
//   • the same dispose lifecycle (renderer's export panel binds them as a
//     pair — both refresh from the same bundle generator)
//   • the same dep surface (`ensureArtifactFiles` + `getArtifactsRootDir`
//     + `joinPath`)
// Peeling these into two groups would create siblings whose deps overlap
// entirely — against the per-group-deps-as-contract intent.
import type { IpcMain } from 'electron'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/** Category slug accepted by `rss:exportFeed` — mirrors the host literal. */
export type ExportFeedType = string

/**
 * Shape of the artifact bundle the host's `ensureArtifactFiles` returns.
 * Mirror of `RSSArtifactsResult` from `./types`, narrowed to the two
 * fields ExportGroup actually reads (`subscriptionsOpml` for the opml
 * export, `masterFeed` + `categoryFeeds` for the feed export). The group
 * never reads `rootDir`, `files.latestUpdate`, or `files.summary`, so
 * those are not in the per-group dep contract.
 */
export interface ExportArtifactBundle {
  readonly files: {
    readonly masterFeed: string
    readonly categoryFeeds: Readonly<Record<string, string>>
    readonly subscriptionsOpml: string
  }
}

/**
 * Per-group deps. The group keeps the response-shaping (`ok` / `fail`),
 * the mock-mode dispatch, the verbatim handler bodies, and the channel
 * list. Everything else — the artifact-bundle generator, the artifacts
 * root directory, the path-join helper — is injected by the host.
 */
export interface ExportGroupDeps {
  /** Whether the engine is running in mock mode (no SQLite, no scrapers). */
  readonly useMock: boolean
  /**
   * Regenerate the full RSS artifact bundle (opml + master feed + category
   * feeds + summary + latest-update) and return its file paths. Owned by
   * the host so ExportGroup never imports the repository / report
   * generator chain directly.
   */
  ensureArtifactFiles(): Promise<ExportArtifactBundle>
  /** Absolute path of the directory the host writes RSS artifacts into. */
  getArtifactsRootDir(): string
  /** Path-join helper (host passes `node:path`'s `join`) so mock-mode path composition stays a pure dep. */
  joinPath(...parts: string[]): string
}

const CHANNELS = [
  'rss:exportOpml',
  'rss:exportFeed',
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

function fail<T = never>(error: string, data?: T): RSSResponse<T> {
  return data === undefined
    ? { success: false, mock: false, error }
    : { success: false, mock: false, error, data }
}

export const exportGroup: IpcChannelGroup<ExportGroupDeps> = {
  namespace: 'rss:export',

  register(ipcMain: IpcMain, deps: ExportGroupDeps): IpcDisposeHandle {
    // Defensive pre-clear — `setupRSSIPC` may be re-entered on dev reload;
    // strip any prior handler so `ipcMain.handle` does not throw on the
    // second registration. Mirrors SourceGroup / ItemGroup / AnalysisGroup
    // / FetchGroup / DiagnosticsGroup.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('rss:exportOpml', async () => {
      if (deps.useMock) {
        return ok({ path: deps.joinPath(deps.getArtifactsRootDir(), 'subscriptions.opml') }, true)
      }

      try {
        const artifacts = await deps.ensureArtifactFiles()
        return ok({ path: artifacts.files.subscriptionsOpml }, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle(
      'rss:exportFeed',
      async (_, type: ExportFeedType = 'master') => {
        if (deps.useMock) {
          return ok({ path: deps.joinPath(deps.getArtifactsRootDir(), 'feed.xml') }, true)
        }

        try {
          const artifacts = await deps.ensureArtifactFiles()
          const path =
            type === 'master'
              ? artifacts.files.masterFeed
              : Object.hasOwn(artifacts.files.categoryFeeds, type) ? artifacts.files.categoryFeeds[type] : undefined
          if (typeof path !== 'string' || !path) throw new Error('分类已删除或无效，未导出其他范围。')
          return ok({ path }, false)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      },
    )

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
export const _exportGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
