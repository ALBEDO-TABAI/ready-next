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

import { ipcMain } from 'electron'

import { ClipPipelineError, runClipPipeline } from '../clipping/clip-pipeline'
import {
  buildSanitizerBundle,
  decodeSanitizerResult,
} from '../clipping/privacy-sanitizer'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'

interface ClipCurrentTabIPCController {
  getActiveTab(): { id: string; url: string; title: string; domain: string } | undefined
  executeJS(tabId: string | null, code: string): Promise<unknown>
}

export interface ClipCurrentTabArgs {
  preset?: string | null
  preset_file?: string | null
  output_subdir?: string | null
  flatten_path?: boolean
  preserve_pagination?: boolean
  force_render_with_placeholders?: boolean
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
): Promise<ClipCurrentTabResult> {
  const activeTab = controller.getActiveTab()
  if (!activeTab) {
    return { ok: false, errorKind: 'clip_no_active_tab', recoverable: false }
  }

  const bundle = buildSanitizerBundle({ preservePagination: Boolean(args.preserve_pagination) })
  let raw: unknown
  try {
    raw = await controller.executeJS(activeTab.id, bundle)
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

  const runtimeInfo = getSkillsRuntimeManager().getRuntimeInfo()
  const presetDir = `${runtimeInfo.skillsRoot}/obsidian-web-clip/assets/presets`

  try {
    const result = await runClipPipeline(
      {
        html: decoded.result.html,
        url: decoded.result.url,
        inlineTitle: decoded.result.title,
        sanitized: true,
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
    return {
      ok: true,
      savedPath: result.savedPath,
      savedPathRelative: result.savedPathRelative,
      suggestedVaultRelativePath: result.suggestedVaultRelativePath,
      preset: result.preset,
      frontmatter: result.frontmatter,
      title: result.title,
      url: result.url,
      warnings: result.warnings,
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
