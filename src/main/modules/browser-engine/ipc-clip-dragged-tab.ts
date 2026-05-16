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
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import { runClipPipeline } from '../clipping/clip-pipeline'
import { fetchClipHtml, fetchJinaMarkdown } from '../clipping/clip-fetch'
import {
  MaterializeError,
  materializeToVault,
  type MaterializeDeps,
  type MaterializeResult,
} from '../clipping/materialize-to-vault'
import {
  runClipDraggedTabBackground,
  validateClipDraggedTabArgs,
  type ClipDraggedTabAck,
  type ClipDraggedTabArgs,
  type ClipDraggedTabIPCController,
  type ClipDraggedTabRunnerDeps,
} from '../clipping/clip-dragged-tab-runner'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'

export type {
  ClipDraggedTabAck,
  ClipDraggedTabArgs,
  ClipBackgroundUpdate,
  ClipBackgroundUpdateRunning,
  ClipBackgroundUpdateCompleted,
  ClipBackgroundUpdateFailed,
} from '../clipping/clip-dragged-tab-runner'

export function buildDefaultDeps(): ClipDraggedTabRunnerDeps {
  return {
    getRuntimeInfo: () => getSkillsRuntimeManager().getRuntimeInfo(),
    fetchHtml: fetchClipHtml,
    fetchJina: fetchJinaMarkdown,
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

const IMAGE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function buildRealMaterializeDeps(): MaterializeDeps {
  return {
    readMarkdown: (path) => readFile(path, 'utf8'),
    unlink: (path) => unlink(path),
    ensureDir: async (path) => {
      await mkdir(path, { recursive: true })
    },
    writeFile: async (path, content) => {
      await writeFile(path, content)
    },
    statIsDirectory: async (path) => {
      const st = await stat(path)
      return st.isDirectory()
    },
    fetchImage: async (url, options) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), options.timeoutMs)
      const linkAbort = () => controller.abort()
      if (options.signal) options.signal.addEventListener('abort', linkAbort, { once: true })
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'user-agent': IMAGE_USER_AGENT,
            accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          },
          redirect: 'follow',
          signal: controller.signal,
        })
        if (!response.ok) return null
        const contentLengthHeader = response.headers.get('content-length')
        if (contentLengthHeader) {
          const declared = Number.parseInt(contentLengthHeader, 10)
          if (Number.isFinite(declared) && declared > options.maxBytes) return null
        }
        const reader = response.body?.getReader()
        if (!reader) return null
        const chunks: Uint8Array[] = []
        let total = 0
         
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            total += value.byteLength
            if (total > options.maxBytes) {
              try { await reader.cancel() } catch { /* noop */ }
              return null
            }
            chunks.push(value)
          }
        }
        const merged = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          merged.set(chunk, offset)
          offset += chunk.byteLength
        }
        const contentType = response.headers.get('content-type') || ''
        return { bytes: merged, contentType }
      } catch {
        return null
      } finally {
        clearTimeout(timer)
        if (options.signal) options.signal.removeEventListener('abort', linkAbort)
      }
    },
    joinPath: (...segments: string[]) => join(...segments),
    basename: (p: string) => basename(p),
    isAbsolute: (p: string) => isAbsolute(p),
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
