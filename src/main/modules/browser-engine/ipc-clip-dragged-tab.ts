/**
 * `browser:clipDraggedTab` — host-IPC-only fire-and-forget channel.
 *
 * Triggered when the renderer drags a browser tab onto FileTree and picks
 * the "网页剪藏" action in the drop popup. Unlike `web_clip_url` (model-facing
 * tool) and `browser:clipCurrentTab` (renderer slash command on active tab),
 * this channel:
 *   - is NOT model-facing (no entry in any tool registry / schema list)
 *   - returns immediately with a taskId (renderer's `invoke` does not block
 *     on the network + parse + write pipeline)
 *   - pushes incremental progress via `clip:backgroundUpdate` events so the
 *     user can keep typing in chat while clipping runs in the background
 *
 * The pure runner lives in `../clipping/clip-dragged-tab-runner.ts` so it
 * can be unit-tested from host Node without electron. This file only wires
 * electron's `ipcMain.handle` and injects the runtime dependencies.
 *
 * All three clip entries (`executeWebClipUrl`, `runClipCurrentTab`, this
 * one) share `runClipPipeline` and write into `<outputsRoot>/
 * obsidian-web-clip/...` per §6.25-8 sandbox.
 */

import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'

import { runClipPipeline } from '../clipping/clip-pipeline'
import { fetchClipHtml, fetchJinaMarkdown } from '../clipping/clip-fetch'
import {
  MaterializeError,
  materializeToVault,
  type MaterializeResult,
} from '../clipping/materialize-to-vault'
import { buildRealMaterializeDeps } from '../clipping/materialize-real-deps'
import {
  runClipDraggedTabBackground,
  validateClipDraggedTabArgs,
  type ClipDraggedTabAck,
  type ClipDraggedTabArgs,
  type ClipDraggedTabIPCController,
  type ClipDraggedTabRunnerDeps,
} from '../clipping/clip-dragged-tab-runner'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'
import { ExternalServiceStore } from '../settings-engine/external-service-store'

export type {
  ClipDraggedTabAck,
  ClipDraggedTabArgs,
  ClipBackgroundUpdate,
  ClipBackgroundUpdateRunning,
  ClipBackgroundUpdateCompleted,
  ClipBackgroundUpdateFailed,
} from '../clipping/clip-dragged-tab-runner'

export function buildDefaultDeps(): ClipDraggedTabRunnerDeps {
  const externalServices = new ExternalServiceStore()
  return {
    getRuntimeInfo: () => getSkillsRuntimeManager().getRuntimeInfo(),
    fetchHtml: fetchClipHtml,
    fetchJina: (url, key, signal) => {
      const config = externalServices.getGeneralResearchConfig()
      return fetchJinaMarkdown(url, key || config.jinaKey, signal, config.jinaBaseUrl)
    },
    runPipeline: runClipPipeline,
    generateTaskId: () => `clip-${Date.now()}-${randomUUID().slice(0, 8)}`,
    materializeToTargetDir: async (sandboxMdPath, targetDir, options) => {
      try {
        const result = await materializeToVault(
          {
            sandboxMdPath,
            targetDir,
            abortSignal: options?.abortSignal,
          },
          buildRealMaterializeDeps(),
        )
        return { ok: true, result }
      } catch (err) {
        if (err instanceof MaterializeError) {
          return { ok: false, error: { kind: err.kind, message: err.message } }
        }
        return {
          ok: false,
          error: { kind: 'target_write_failed', message: (err as Error).message },
        }
      }
    },
  }
}

export function setupBrowserClipDraggedTabIPC(
  controller: ClipDraggedTabIPCController,
  deps: ClipDraggedTabRunnerDeps = buildDefaultDeps(),
): void {
  ipcMain.handle('browser:clipDraggedTab', async (_, raw: unknown): Promise<ClipDraggedTabAck> => {
    const validation = validateClipDraggedTabArgs(raw)
    if (!validation.ok) return validation
    const args = raw as ClipDraggedTabArgs
    const taskId = args.client_task_id || deps.generateTaskId()
    // Fire-and-forget. Any throw inside is swallowed by the runner and
    // emitted as a 'failed' update — we never want unhandled rejection
    // here because invoke has already acked.
    void runClipDraggedTabBackground(taskId, args, controller, deps)
    return { ok: true, taskId }
  })
}
