/**
 * Pure runner for the drag-tab-to-FileTree background clip.
 *
 * Lives outside `browser-engine/` because it must be testable from host
 * Node — `browser-engine/ipc-clip-dragged-tab.ts` imports `electron` and
 * cannot be loaded by `tsx --test` directly. This module only depends on
 * `clip-pipeline` + `clip-fetch` (both already pure).
 *
 * The IPC registration file injects the electron-dependent dependencies
 * (`getRuntimeInfo`, real fetch helpers) via the `deps` object.
 */

import { ClipPipelineError, runClipPipeline } from './clip-pipeline'
import { ClipFetchError, fetchClipHtml, fetchJinaMarkdown } from './clip-fetch'
import {
  MaterializeError,
  materializeToVault,
  type MaterializeDeps,
  type MaterializeResult,
} from './materialize-to-vault'

interface RuntimeInfoLike {
  skillsRoot: string
  outputsRoot: string
}

export interface ClipDraggedTabRunnerDeps {
  getRuntimeInfo: () => RuntimeInfoLike
  fetchHtml: typeof fetchClipHtml
  fetchJina: typeof fetchJinaMarkdown
  runPipeline: typeof runClipPipeline
  generateTaskId: () => string
  /**
   * Materialize a sandbox .md into a user-supplied vault folder: download
   * image assets to `<targetDir>/<noteBaseName>.assets/`, rewrite the
   * markdown image references to relative paths, write the final .md to
   * `<targetDir>/<noteBaseName>.md`, and unlink the sandbox file. Move
   * semantics — sandbox never accumulates orphans.
   *
   * Pure dep so tests can inject a memory recorder. The IPC layer wires
   * the real fs + http impl in `buildDefaultDeps`.
   */
  materializeToTargetDir: (
    sandboxMdPath: string,
    targetDir: string,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<
    | { ok: true; result: MaterializeResult }
    | { ok: false; error: { kind: MaterializeError['kind']; message: string } }
  >
}

export type { MaterializeDeps, MaterializeResult } from './materialize-to-vault'

export interface ClipDraggedTabArgs {
  url: string
  title?: string
  preset?: string | null
  preset_file?: string | null
  output_subdir?: string | null
  flatten_path?: boolean
  force_render_with_placeholders?: boolean
  /** Diagnostic only — folder the user dragged into. Does not change write path. */
  target_hint?: string
  /**
   * Absolute path of the folder the user dragged into. When present and a
   * valid directory, the saved .md is copied here after the sandboxed write
   * succeeds. The canonical artifact still lives under outputsRoot; this is
   * a user-authorized side copy, analogous to "Save As". Falsy/invalid →
   * skip copy. NOT a write target for the pipeline itself.
   */
  target_dir?: string
  /** Optional client-side correlation id. If absent, runner generates one. */
  client_task_id?: string
}

export interface ClipDraggedTabAck {
  ok: boolean
  taskId?: string
  errorKind?: 'invalid_url' | 'invalid_args'
  errorDetail?: { message: string }
}

export interface ClipBackgroundUpdateRunning {
  taskId: string
  status: 'running'
  url: string
  title?: string
  targetHint?: string
}

export interface ClipBackgroundUpdateCompleted {
  taskId: string
  status: 'completed'
  url: string
  title?: string
  targetHint?: string
  /** Sandbox path. Empty when materialization succeeded (sandbox file moved). */
  savedPath: string
  savedPathRelative: string
  suggestedVaultRelativePath: string
  /** Final path in the user-chosen vault folder when target_dir succeeded. */
  copiedPath?: string
  /** Absolute paths of downloaded image assets in `<target>.assets/`. */
  assetPaths?: string[]
  /** Count of image references that failed to download (left as remote URLs). */
  imageDownloadFailures?: number
  /** Materialization failed; sandbox file is still authoritative at savedPath. */
  copyError?: {
    kind: MaterializeError['kind']
    message: string
  }
  preset: { id: string; name: string }
  frontmatter: Record<string, string | string[]>
  warnings: string[]
}

export interface ClipBackgroundUpdateFailed {
  taskId: string
  status: 'failed'
  url: string
  title?: string
  targetHint?: string
  errorKind:
    | 'clip_fetch_failed'
    | 'clip_parse_failed'
    | 'clip_preset_render_failed'
    | 'clip_login_required'
    | 'clip_write_blocked'
    | 'clip_active_tab_unstable'
    | 'unexpected'
  recoverable: boolean
  errorDetail?: Record<string, unknown>
}

export type ClipBackgroundUpdate =
  | ClipBackgroundUpdateRunning
  | ClipBackgroundUpdateCompleted
  | ClipBackgroundUpdateFailed

export interface ClipDraggedTabIPCController {
  sendToRenderer(channel: string, data: unknown): void
}

const HTTP_RE = /^https?:\/\//i

export function validateClipDraggedTabArgs(raw: unknown): ClipDraggedTabAck {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errorKind: 'invalid_args', errorDetail: { message: 'args must be an object' } }
  }
  const args = raw as ClipDraggedTabArgs
  if (typeof args.url !== 'string' || args.url.trim().length === 0) {
    return { ok: false, errorKind: 'invalid_args', errorDetail: { message: 'url is required' } }
  }
  if (!HTTP_RE.test(args.url)) {
    return {
      ok: false,
      errorKind: 'invalid_url',
      errorDetail: { message: 'clipDraggedTab only accepts http(s) URLs' },
    }
  }
  return { ok: true }
}

export async function runClipDraggedTabBackground(
  taskId: string,
  args: ClipDraggedTabArgs,
  controller: ClipDraggedTabIPCController,
  deps: ClipDraggedTabRunnerDeps,
): Promise<void> {
  const base = {
    taskId,
    url: args.url,
    title: args.title,
    targetHint: args.target_hint,
  }

  emit(controller, { ...base, status: 'running' })

  try {
    const fetched = await deps.fetchHtml(args.url, undefined)
    let jinaMarkdown: string | undefined
    try {
      jinaMarkdown = await deps.fetchJina(args.url, undefined, undefined)
    } catch {
      jinaMarkdown = undefined
    }

    const runtimeInfo = deps.getRuntimeInfo()
    const presetDir = `${runtimeInfo.skillsRoot}/obsidian-web-clip/assets/presets`

    const result = await deps.runPipeline(
      {
        html: fetched.html,
        url: fetched.finalUrl,
        inlineTitle: args.title || fetched.titleFromHead,
        jinaMarkdown,
        sanitized: false,
      },
      {
        presetDir,
        presetFile: args.preset_file ?? null,
        preset: args.preset ?? 'auto',
        outputSubdir: args.output_subdir ?? null,
        flattenPath: Boolean(args.flatten_path),
        forceRenderWithPlaceholders: Boolean(args.force_render_with_placeholders),
        outputsRoot: runtimeInfo.outputsRoot,
      },
    )

    let copiedPath: string | undefined
    let assetPaths: string[] | undefined
    let imageDownloadFailures: number | undefined
    let copyError: ClipBackgroundUpdateCompleted['copyError']
    let savedPathAfterMaterialize = result.savedPath
    if (args.target_dir && args.target_dir.trim().length > 0) {
      const materialized = await deps.materializeToTargetDir(result.savedPath, args.target_dir)
      if (materialized.ok) {
        copiedPath = materialized.result.finalMdPath
        assetPaths = materialized.result.assetPaths
        imageDownloadFailures = materialized.result.imageDownloadFailures
        // Sandbox file has been moved; clear savedPath so downstream knows
        // the canonical location is the vault, not the sandbox.
        savedPathAfterMaterialize = ''
      } else {
        copyError = materialized.error
      }
    }

    emit(controller, {
      ...base,
      status: 'completed',
      savedPath: savedPathAfterMaterialize,
      savedPathRelative: result.savedPathRelative,
      suggestedVaultRelativePath: result.suggestedVaultRelativePath,
      copiedPath,
      assetPaths,
      imageDownloadFailures,
      copyError,
      preset: result.preset,
      frontmatter: result.frontmatter,
      warnings: result.warnings,
    })
  } catch (err) {
    emit(controller, mapErrorToFailedUpdate(err, base))
  }
}

function mapErrorToFailedUpdate(
  err: unknown,
  base: { taskId: string; url: string; title?: string; targetHint?: string },
): ClipBackgroundUpdateFailed {
  if (err instanceof ClipFetchError) {
    if (err.kind === 'login_required') {
      return {
        ...base,
        status: 'failed',
        errorKind: 'clip_login_required',
        recoverable: false,
        errorDetail: { message: err.message },
      }
    }
    return {
      ...base,
      status: 'failed',
      errorKind: 'clip_fetch_failed',
      recoverable: true,
      errorDetail: { message: err.message },
    }
  }
  if (err instanceof ClipPipelineError) {
    return {
      ...base,
      status: 'failed',
      errorKind: err.kind,
      recoverable: err.recoverable,
      errorDetail: err.detail as unknown as Record<string, unknown>,
    }
  }
  return {
    ...base,
    status: 'failed',
    errorKind: 'unexpected',
    recoverable: false,
    errorDetail: { message: (err as Error).message },
  }
}

function emit(controller: ClipDraggedTabIPCController, update: ClipBackgroundUpdate): void {
  controller.sendToRenderer('clip:backgroundUpdate', update)
}
