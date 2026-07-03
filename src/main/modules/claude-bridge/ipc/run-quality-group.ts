/**
 * P0-4 (2026-07-02 P0 visibility batch) — read-only run quality stats for
 * the settings dashboard. One channel, metrics-log single source.
 */
import type { IpcMain } from 'electron'
import {
  aggregateRunQualityStats,
  readMetricsLogTailLines,
  type RunQualityStats,
} from '../../agent-control/quality/run-quality-stats'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface RunQualityGroupDeps {
  /** Injectable for tests; production uses the bounded metrics-log tail. */
  readMetricsLines?: () => string[]
  now?: () => Date
}

const CHANNELS = ['agent:runQuality:stats'] as const

export const runQualityGroup: IpcChannelGroup<RunQualityGroupDeps> = {
  namespace: 'agent:runQuality',

  register(ipcMain: IpcMain, deps: RunQualityGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
    }

    ipcMain.handle('agent:runQuality:stats', async (): Promise<IPCResponse<RunQualityStats>> => {
      try {
        const lines = deps.readMetricsLines ? deps.readMetricsLines() : readMetricsLogTailLines()
        const now = deps.now ? deps.now() : new Date()
        return { success: true, data: aggregateRunQualityStats(lines, { now }) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    return {
      dispose() {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
        }
      },
    }
  },
}

export const _runQualityGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
