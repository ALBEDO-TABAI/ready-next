/**
 * P1.3 / P1.6 — `web_clip_url` tool.
 *
 * Fetches a public http(s) URL, extracts main content, renders an Obsidian
 * Web Clipper-style preset, writes the resulting Markdown note under
 * `<outputsRoot>/obsidian-web-clip/...`, and calls `present_file` so the
 * renderer surfaces the produced note as an attachment chip.
 *
 * Boundaries:
 * - Public URLs only. Login-walled / paywalled pages return
 *   `clip_login_required`. Users wanting to clip logged-in or current-tab
 *   pages must invoke the host-IPC `browser:clipCurrentTab` channel via
 *   the renderer slash command `/clip-current` (P1.4).
 * - Path sandbox per §6.25-8: every write goes through
 *   `resolveReadableWithinRoot(outputsRoot, ...)`.
 * - No new `ToolContext` fields beyond what `present_file` / `web_fetch`
 *   already consume (Stage R 8-contract #4).
 *
 * Pure module — no electron, no skills-runtime imports.
 */

import { z } from 'zod'

import { ToolDomainError } from '../tool-errors'
import {
  ClipPipelineError,
  runClipPipeline,
  type ClipPipelineOptions,
} from '../../clipping/clip-pipeline'
import {
  ClipFetchError,
  fetchClipHtml,
  fetchJinaMarkdown,
} from '../../clipping/clip-fetch'

export const webClipUrlSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), {
      message: 'web_clip_url only accepts http(s) URLs; file://, chrome:// and other schemes are rejected',
    })
    .describe('要剪藏的页面 URL；只接受 public http(s) 协议；登录态页面请用 /clip-current'),
  preset: z
    .string()
    .optional()
    .describe('preset 文件名（不带 .json）或 "auto"（默认）；含 LLM 占位的 preset 需要 Phase 2 interpreter'),
  preset_file: z
    .string()
    .optional()
    .describe('显式 preset JSON 路径；优先级高于 preset 字段'),
  output_subdir: z
    .string()
    .optional()
    .describe('落盘子目录（在 outputs/obsidian-web-clip/ 之下），可覆盖 preset.path'),
  flatten_path: z
    .boolean()
    .optional()
    .describe('忽略 preset.path 直接写入 outputs/obsidian-web-clip/；默认 false'),
  force_render_with_placeholders: z
    .boolean()
    .optional()
    .describe('允许渲染含 LLM 占位的 preset：占位渲染为 [placeholder: "<原指令>"] 字面块；默认 false'),
  reason: z
    .string()
    .optional()
    .describe('抓取动机（可选），帮助调度观察意图'),
})

export type WebClipUrlArgs = z.infer<typeof webClipUrlSchema>

export interface WebClipUrlResult {
  url: string
  title: string
  preset: { id: string; name: string }
  savedPath: string
  savedPathRelative: string
  suggestedVaultRelativePath: string
  frontmatter: Record<string, string | string[]>
  warnings: string[]
}

export interface WebClipUrlContext {
  abortSignal?: AbortSignal
  sessionId?: string
  outputsRoot: string
  /** Embedded skill preset dir; injected by dispatcher. */
  presetDir: string
  /** Optional Jina reader key. */
  jinaKey?: string
  jinaBaseUrl?: string
  requestModuleToolAction?: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
}

export async function executeWebClipUrl(
  args: WebClipUrlArgs,
  ctx: WebClipUrlContext,
): Promise<WebClipUrlResult> {
  if (!ctx.outputsRoot) {
    throw new ToolDomainError(
      'clip_write_blocked',
      'outputsRoot is not configured for web_clip_url',
    )
  }
  if (!ctx.presetDir) {
    throw new ToolDomainError(
      'clip_preset_render_failed',
      'preset directory is not configured for web_clip_url',
    )
  }

  let html: string
  let finalUrl: string
  let inlineTitle: string | undefined
  let jinaMarkdown: string | undefined
  let rawFetchError: unknown = null

  try {
    const fetched = await fetchClipHtml(args.url, ctx.abortSignal)
    html = fetched.html
    finalUrl = fetched.finalUrl
    inlineTitle = fetched.titleFromHead
  } catch (err) {
    rawFetchError = err
    html = ''
    finalUrl = args.url
  }

  try {
    jinaMarkdown = await fetchJinaMarkdown(args.url, ctx.jinaKey, ctx.abortSignal, ctx.jinaBaseUrl)
  } catch {
    jinaMarkdown = undefined
  }

  if (!html && !jinaMarkdown) {
    if (rawFetchError instanceof ClipFetchError && rawFetchError.kind === 'login_required') {
      throw new ToolDomainError('clip_login_required', rawFetchError.message)
    }
    if (rawFetchError instanceof ClipFetchError) {
      throw new ToolDomainError('clip_fetch_failed', rawFetchError.message)
    }
    throw new ToolDomainError(
      'clip_fetch_failed',
      `Failed to fetch ${args.url}: ${rawFetchError instanceof Error ? rawFetchError.message : String(rawFetchError || 'unknown')}`,
    )
  }

  const pipelineOptions: ClipPipelineOptions = {
    presetDir: ctx.presetDir,
    presetFile: args.preset_file ?? null,
    preset: args.preset ?? 'auto',
    outputSubdir: args.output_subdir ?? null,
    flattenPath: Boolean(args.flatten_path),
    forceRenderWithPlaceholders: Boolean(args.force_render_with_placeholders),
    outputsRoot: ctx.outputsRoot,
  }

  let result
  try {
    result = await runClipPipeline(
      { html, url: finalUrl, inlineTitle, jinaMarkdown, sanitized: false },
      pipelineOptions,
    )
  } catch (err) {
    if (err instanceof ClipPipelineError) {
      throw new ToolDomainError(err.kind, err.message, { detail: err.detail })
    }
    throw err
  }

  // Surface to renderer as a present_file attachment chip.
  if (ctx.requestModuleToolAction) {
    try {
      await ctx.requestModuleToolAction('renderer:present-file', {
        path: result.savedPath,
        reason: `obsidian-web-clip note (preset: ${result.preset.id})`,
      })
    } catch {
      // present_file failure is non-fatal — the file is already on disk.
    }
  }

  return {
    url: result.url,
    title: result.title,
    preset: result.preset,
    savedPath: result.savedPath,
    savedPathRelative: result.savedPathRelative,
    suggestedVaultRelativePath: result.suggestedVaultRelativePath,
    frontmatter: result.frontmatter,
    warnings: result.warnings,
  }
}
