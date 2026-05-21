// Stage V V2.2c — rss-engine AnalysisGroup channel cluster.
//
// Bundles the 6 channels that drive the renderer's "analyze this RSS item"
// surface — the copy/visual analysis pipeline backed by
// `RSSItemAnalysisManager`:
//
//   rss:startItemAnalysis        (queue a new copy/visual analysis job)
//   rss:getItemAnalysisProgress  (per-item progress map for inbox badges)
//   rss:listItemAnalysisJobs     (recent jobs, optionally filtered by item)
//   rss:pauseAnalysisJob         (pause a running / queued job by id)
//   rss:resumeAnalysisJob        (resume a previously paused job)
//   rss:deleteAnalysisJob        (delete one job + its output dir)
//
// Handler bodies are lifted verbatim from `ipc-handler.ts` (V2.2c is a
// move + thin-wrapper, same shape as V2.2a SourceGroup and V2.2b
// ItemGroup). Response shaping (`ok` / `fail`) and mock-mode dispatch
// stay inside this group; the only collaborators the handlers touch are
// the analysis-manager singleton and the `mapAnalysisJob` row → API
// mapper, both exposed through per-group deps so the test can fake them
// without dragging the full `EngineDeps` surface in.
//
// The 6 channels live in one group despite mixing a write
// (`startItemAnalysis`), a per-item read (`getItemAnalysisProgress`),
// a multi-item read (`listItemAnalysisJobs`) and three lifecycle
// mutations (`pause` / `resume` / `delete`) because they share:
//   • the same domain concept (an "analysis job" attached to an RSS item)
//   • the same dispose lifecycle (renderer's inbox-analysis panel binds
//     them as a single feature toggle)
//   • the same dep surface (manager + job mapper + mock flag)
// Splitting reads from writes here would create siblings whose deps
// overlap entirely — against the per-group-deps-as-contract intent
// documented in `engine-deps.ts`.
import type { IpcMain } from 'electron'
import type { RSSAnalysisAction, RSSAnalysisJob } from '../../database'
import type { RSSItemAnalysisManager } from '../item-analysis-manager'
import type { EngineDeps } from './engine-deps'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Shape of the analysis-job API row returned to the renderer. Kept here
 * (and re-exported via `AnalysisGroupDeps`) so the host's mapper retains
 * a single typed contract on both sides of the move — copy of the
 * inline `MappedRSSAnalysisJob` interface that previously lived in
 * `ipc-handler.ts`.
 */
export interface MappedRSSAnalysisJob {
  id: string
  itemId: string
  action: RSSAnalysisAction
  sourceUrl: string
  title: string
  targetDir: string
  outputDir: string
  reportPath: string | null
  status: string
  progress: number
  message: string | null
  error: string | null
  meta: Record<string, unknown> | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  finishedAt: string | null
}

/**
 * Shape of the per-item progress payload emitted by
 * `rss:getItemAnalysisProgress`. Mirrors the inline type the host
 * exposes to its progress-poller; kept local so AnalysisGroup is
 * self-describing.
 */
export interface RSSAnalysisProgressPayload {
  itemId: string
  jobId: string
  action: RSSAnalysisAction
  status: string
  progress: number
  message: string | null
  error: string | null
  outputDir: string
  reportPath: string | null
  updatedAt: string
}

/**
 * Per-group deps — subset of `EngineDeps` plus the analysis manager +
 * mapper the host owns. Tests pass a fake that implements exactly these
 * three members; nothing more is required to exercise the 6 handler
 * bodies.
 *
 * `getAnalysisManager()` is lazy on purpose — `setupRSSIPC` calls
 * `getRSSItemAnalysisManager()` once and binds the resulting singleton,
 * but the group cannot import that helper directly without pulling
 * `item-analysis-manager.ts` (and its scraper / browser-controller
 * transitive deps) into every group test. The host wraps the singleton
 * with `() => analysisManager` instead.
 */
export interface AnalysisGroupDeps {
  /** Whether the engine is running in mock mode (no SQLite, no manager). */
  readonly useMock: EngineDeps['useMock']
  /** Singleton analysis manager (lazy so the test can fake it). */
  getAnalysisManager(): RSSItemAnalysisManager
  /** Map a DB analysis-job row → renderer-facing API shape. */
  mapAnalysisJob(job: RSSAnalysisJob): MappedRSSAnalysisJob
}

const CHANNELS = [
  'rss:startItemAnalysis',
  'rss:getItemAnalysisProgress',
  'rss:listItemAnalysisJobs',
  'rss:pauseAnalysisJob',
  'rss:resumeAnalysisJob',
  'rss:deleteAnalysisJob',
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

export const analysisGroup: IpcChannelGroup<AnalysisGroupDeps> = {
  namespace: 'rss:analysis',

  register(ipcMain: IpcMain, deps: AnalysisGroupDeps): IpcDisposeHandle {
    // Defensive pre-clear — `setupRSSIPC` may be re-entered on dev reload;
    // strip any prior handler so `ipcMain.handle` does not throw on the
    // second registration. Mirrors SourceGroup / ItemGroup.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle(
      'rss:startItemAnalysis',
      async (
        _event,
        payload: {
          itemId: string
          action: RSSAnalysisAction
          link: string
          title: string
          targetDir: string
          source?: string
          summary?: string
          publishedAt?: string
          force?: boolean
        },
      ) => {
        if (deps.useMock) {
          const now = new Date().toISOString()
          return ok(
            {
              id: `mock-analysis-${Date.now()}`,
              itemId: payload.itemId,
              action: payload.action,
              sourceUrl: payload.link,
              title: payload.title,
              targetDir: payload.targetDir,
              outputDir: payload.targetDir,
              reportPath: null,
              status: 'queued',
              progress: 5,
              message: 'mock queued',
              error: null,
              meta: null,
              createdAt: now,
              startedAt: null,
              updatedAt: now,
              finishedAt: null,
            } satisfies MappedRSSAnalysisJob,
            true,
          )
        }

        try {
          if (!payload?.itemId || !payload?.link || !payload?.title || !payload?.targetDir) {
            return fail('Missing required fields: itemId, link, title, targetDir')
          }
          if (payload.action !== 'copy' && payload.action !== 'visual') {
            return fail(`Unsupported analysis action: ${String(payload.action)}`)
          }
          const job = await deps.getAnalysisManager().startItemAnalysis({
            itemId: payload.itemId,
            action: payload.action,
            link: payload.link,
            title: payload.title,
            targetDir: payload.targetDir,
            source: payload.source,
            summary: payload.summary,
            publishedAt: payload.publishedAt,
            force: payload.force,
          })
          return ok(deps.mapAnalysisJob(job), false)
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }
      },
    )

    ipcMain.handle('rss:getItemAnalysisProgress', async (_event, payload?: { itemIds?: string[] }) => {
      if (deps.useMock) return ok({} as Record<string, RSSAnalysisProgressPayload>, true)

      try {
        const itemIds = Array.isArray(payload?.itemIds)
          ? payload!.itemIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
          : undefined
        const progress = deps.getAnalysisManager().getItemProgress(itemIds)
        return ok(progress as Record<string, RSSAnalysisProgressPayload>, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle('rss:listItemAnalysisJobs', async (_event, payload?: { itemId?: string; limit?: number }) => {
      if (deps.useMock) return ok([] as MappedRSSAnalysisJob[], true)

      try {
        const jobs = deps
          .getAnalysisManager()
          .listJobs(payload?.itemId, payload?.limit)
          .map((job) => deps.mapAnalysisJob(job))
        return ok(jobs, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle('rss:pauseAnalysisJob', async (_event, payload?: { jobId?: string }) => {
      if (deps.useMock) return ok({ paused: false }, true)
      try {
        if (!payload?.jobId) return fail('Missing jobId')
        const job = deps.getAnalysisManager().pauseJob(payload.jobId)
        return ok({ paused: true, job: deps.mapAnalysisJob(job) }, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle('rss:resumeAnalysisJob', async (_event, payload?: { jobId?: string }) => {
      if (deps.useMock) return ok({ resumed: false }, true)
      try {
        if (!payload?.jobId) return fail('Missing jobId')
        const job = deps.getAnalysisManager().resumeJob(payload.jobId)
        return ok({ resumed: true, job: deps.mapAnalysisJob(job) }, false)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    })

    ipcMain.handle('rss:deleteAnalysisJob', async (_event, payload?: { jobId?: string }) => {
      if (deps.useMock) return ok({ deleted: false }, true)
      try {
        if (!payload?.jobId) return fail('Missing jobId')
        const result = deps.getAnalysisManager().deleteJob(payload.jobId)
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
export const _analysisGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
