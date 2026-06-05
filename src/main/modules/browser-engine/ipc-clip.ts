/**
 * P1.4 — `browser:clipCurrentTab` IPC.
 *
 * Renderer-driven, NEVER model-driven (Codex iter-2 Q2):
 *   - Slash command `/clip-current` (BrowserView toolbar) is the only
 *     legitimate caller.
 *   - This IPC channel is NOT registered as a model-facing tool (no entry
 *     in `STATIC_TOOL_INPUT_SCHEMAS`, no entry in any `getToolDefinitions`
 *     output). The skill SKILL.md tells the model to delegate to the user.
 *
 * Flow:
 *   1. Get the active BrowserView tab.
 *   2. Inject the privacy-sanitizer bundle via executeJavaScript(code, false).
 *   3. Validate result shape → sanitized HTML + audit summary.
 *   4. Pipe HTML into shared `runClipPipeline()`.
 *   5. Return savedPath + sanitizationSummary to renderer; renderer surfaces
 *      a toast + opens the saved note via the present-file pipeline.
 *
 * Failure mapping:
 *   - `unsupported_protocol` / `document_unavailable` → return errorKind
 *     `clip_parse_failed { reason: 'extraction_threw' }`.
 *   - sanitizer reported `stable=false` → `clip_active_tab_unstable`.
 *   - pipeline throws → forward errorKind + recoverable flag to renderer.
 */

import { createRequire } from 'node:module'

const electronModule = createRequire(import.meta.url)('electron') as typeof import('electron')
const { ipcMain } = electronModule

import { ClipPipelineError, runClipPipeline } from '../clipping/clip-pipeline'
import { materializeToVault } from '../clipping/materialize-to-vault'
import { buildRealMaterializeDeps } from '../clipping/materialize-real-deps'
import {
  buildSanitizerBundle,
  decodeSanitizerResult,
} from '../clipping/privacy-sanitizer'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'

interface ClipCurrentTabIPCController {
  getActiveTab(): { id: string; url: string; title: string; domain: string } | undefined
  getTab?(tabId: string): { id: string; url: string; title: string; domain: string } | undefined
  executeJS(tabId: string | null, code: string): Promise<unknown>
}

interface ClipCurrentTabRuntimeInfo {
  skillsRoot: string
  outputsRoot: string
}

interface ClipCurrentTabDeps {
  getRuntimeInfo?: () => ClipCurrentTabRuntimeInfo
  runClipPipeline?: typeof runClipPipeline
  materializeToVault?: typeof materializeToVault
  buildMaterializeDeps?: typeof buildRealMaterializeDeps
}

export interface ClipCurrentTabArgs {
  tab_id?: string | null
  preset?: string | null
  preset_file?: string | null
  output_subdir?: string | null
  flatten_path?: boolean
  preserve_pagination?: boolean
  force_render_with_placeholders?: boolean
  target_hint?: string
  target_dir?: string
}

export interface ClipCurrentTabResult {
  ok: boolean
  errorKind?:
    | 'clip_no_active_tab'
    | 'clip_parse_failed'
    | 'clip_active_tab_unstable'
    | 'clip_fetch_failed'
    | 'clip_preset_render_failed'
    | 'clip_login_required'
    | 'clip_write_blocked'
  recoverable?: boolean
  errorDetail?: Record<string, unknown>
  savedPath?: string
  savedPathRelative?: string
  suggestedVaultRelativePath?: string
  preset?: { id: string; name: string }
  frontmatter?: Record<string, string | string[]>
  title?: string
  url?: string
  copiedPath?: string
  assetPaths?: string[]
  imageDownloadFailures?: number
  copyError?: {
    kind: string
    message: string
  }
  warnings?: string[]
  sanitizationSummary?: Record<string, number>
}

export function setupBrowserClipIPC(controller: ClipCurrentTabIPCController): void {
  ipcMain.handle('browser:clipCurrentTab', async (_, args: ClipCurrentTabArgs = {}) => {
    return runClipCurrentTab(controller, args)
  })
}

export async function runClipCurrentTab(
  controller: ClipCurrentTabIPCController,
  args: ClipCurrentTabArgs,
  deps: ClipCurrentTabDeps = {},
): Promise<ClipCurrentTabResult> {
  const requestedTabId = args.tab_id?.trim()
  const targetTab = requestedTabId
    ? controller.getTab?.(requestedTabId)
    : controller.getActiveTab()
  if (!targetTab) {
    return { ok: false, errorKind: 'clip_no_active_tab', recoverable: false }
  }

  const bundle = buildSanitizerBundle({ preservePagination: Boolean(args.preserve_pagination) })
  let raw: unknown
  try {
    raw = await controller.executeJS(targetTab.id, bundle)
  } catch (err) {
    return {
      ok: false,
      errorKind: 'clip_parse_failed',
      recoverable: false,
      errorDetail: { reason: 'extraction_threw', message: (err as Error).message },
    }
  }

  let decoded
  try {
    decoded = decodeSanitizerResult(raw)
  } catch (err) {
    return {
      ok: false,
      errorKind: 'clip_parse_failed',
      recoverable: false,
      errorDetail: { reason: 'extraction_threw', message: (err as Error).message },
    }
  }

  if (!decoded.result.ok) {
    return {
      ok: false,
      errorKind: 'clip_parse_failed',
      recoverable: false,
      errorDetail: { reason: decoded.result.reason },
    }
  }

  if (!decoded.result.stable) {
    return {
      ok: false,
      errorKind: 'clip_active_tab_unstable',
      recoverable: true,
      errorDetail: {
        startUrl: decoded.audit.startUrl,
        finalUrl: decoded.audit.finalUrl,
      },
      sanitizationSummary: decoded.result.sanitizationSummary as unknown as Record<string, number>,
    }
  }

  const runtimeInfo = deps.getRuntimeInfo?.() ?? getSkillsRuntimeManager().getRuntimeInfo()
  const presetDir = `${runtimeInfo.skillsRoot}/obsidian-web-clip/assets/presets`
  const runPipeline = deps.runClipPipeline ?? runClipPipeline
  const materialize = deps.materializeToVault ?? materializeToVault
  const buildMaterialize = deps.buildMaterializeDeps ?? buildRealMaterializeDeps

  try {
    const pipelineInput = {
      html: decoded.result.html,
      url: decoded.result.url,
      inlineTitle: decoded.result.title,
      sanitized: true,
    }
    const pipelineOptions = {
      presetDir,
      presetFile: args.preset_file ?? null,
      preset: args.preset ?? 'auto',
      outputSubdir: args.output_subdir ?? null,
      flattenPath: Boolean(args.flatten_path),
      forceRenderWithPlaceholders: Boolean(args.force_render_with_placeholders),
      outputsRoot: runtimeInfo.outputsRoot,
    }
    const warnings: string[] = []
    let result
    try {
      result = await runPipeline(pipelineInput, pipelineOptions)
    } catch (err) {
      const canFallbackToArticle =
        err instanceof ClipPipelineError
        && err.kind === 'clip_preset_render_failed'
        && err.detail.reason === 'requires_interpreter'
        && !args.preset_file
        && (!args.preset || args.preset === 'auto')
        && !args.force_render_with_placeholders
      if (!canFallbackToArticle) throw err
      result = await runPipeline(pipelineInput, {
        ...pipelineOptions,
        preset: 'article-clipper',
      })
      warnings.push('preset_requires_interpreter_fallback_to_article')
    }
    let copiedPath: string | undefined
    let assetPaths: string[] | undefined
    let imageDownloadFailures: number | undefined
    let copyError: ClipCurrentTabResult['copyError']
    let savedPathAfterMaterialize = result.savedPath

    if (args.target_dir && args.target_dir.trim().length > 0) {
      try {
        const materialized = await materialize(
          {
            sandboxMdPath: result.savedPath,
            targetDir: args.target_dir,
            sourcePageUrl: decoded.result.url,
          },
          buildMaterialize(),
        )
        copiedPath = materialized.finalMdPath
        assetPaths = materialized.assetPaths
        imageDownloadFailures = materialized.imageDownloadFailures
        savedPathAfterMaterialize = ''
      } catch (err) {
        const maybeMaterialize = err as { kind?: string; message?: string }
        copyError = {
          kind: maybeMaterialize.kind || 'target_write_failed',
          message: maybeMaterialize.message || (err as Error).message,
        }
      }
    }

    return {
      ok: true,
      savedPath: savedPathAfterMaterialize,
      savedPathRelative: result.savedPathRelative,
      suggestedVaultRelativePath: result.suggestedVaultRelativePath,
      preset: result.preset,
      frontmatter: result.frontmatter,
      title: result.title,
      url: result.url,
      copiedPath,
      assetPaths,
      imageDownloadFailures,
      copyError,
      warnings: [...warnings, ...result.warnings],
      sanitizationSummary: decoded.result.sanitizationSummary as unknown as Record<string, number>,
    }
  } catch (err) {
    if (err instanceof ClipPipelineError) {
      return {
        ok: false,
        errorKind: err.kind,
        recoverable: err.recoverable,
        errorDetail: err.detail as unknown as Record<string, unknown>,
      }
    }
    return {
      ok: false,
      errorKind: 'clip_parse_failed',
      recoverable: false,
      errorDetail: { message: (err as Error).message },
    }
  }
}
