/**
 * Stage R — `general_research` group dispatcher.
 *
 * Routes the three general-research tools (`web_search`, `web_fetch`,
 * `present_file`) into their per-tool implementations under `builtins/`.
 * Each branch performs Zod parsing locally even though the dispatch layer
 * already validates input via `tool-input-validator`; this preserves the
 * pure-handler contract — the handlers know their own arg type instead
 * of trusting `Record<string, unknown>` from the executor.
 *
 * Failure semantics: every handler throws `ToolDomainError`, which the
 * dispatch layer (`tool-executor.ts:errorKindFor`) maps to the explicit
 * `errorKind` (e.g. `web_search_failed`, `web_fetch_failed`,
 * `present_file_failed`, `path_outside_outputs`). Bare `Error` would
 * silently bucket into `tool_handler_failure` — losing the kind we want
 * downstream retry policy to gate on.
 *
 * Pure module — no electron, no skills-runtime imports.
 */

import type { ConversationScope } from '../agent-control/types'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tool-result-types'
import { ToolDomainError } from './tool-errors'
import {
  executePresentFile,
  presentFileSchema,
} from './builtins/present-file'
import {
  executeWebClipUrl,
  webClipUrlSchema,
} from './builtins/web-clip-url'
import {
  executeWebFetch,
  webFetchSchema,
} from './builtins/web-fetch'
import {
  executeWebSearch,
  webSearchSchema,
} from './builtins/web-search'

export interface GeneralResearchToolContext {
  abortSignal?: AbortSignal
  sessionId?: string
  outputsRoot: string
  requestModuleToolAction?: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  scope?: ConversationScope | null
  /** Optional Tavily API key for web_search / web_fetch backends. */
  tavilyKey?: string
  /** Optional Jina reader key for web_fetch. */
  jinaKey?: string
  /** Embedded skill preset dir for `web_clip_url`; injected by host. */
  obsidianWebClipPresetDir?: string
}

export async function executeGeneralResearchTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: GeneralResearchToolContext,
): Promise<string | ToolExecutionOutput> {
  switch (toolName) {
    case 'web_search': {
      const parsed = webSearchSchema.safeParse(args)
      if (!parsed.success) {
        throw new ToolDomainError('input_validation', parsed.error.message)
      }
      const result = await executeWebSearch(parsed.data, {
        abortSignal: ctx.abortSignal,
        tavilyKey: ctx.tavilyKey,
      })
      return createToolExecutionOutput(JSON.stringify(result), {
        data: result as unknown as Record<string, unknown>,
      })
    }
    case 'web_fetch': {
      const parsed = webFetchSchema.safeParse(args)
      if (!parsed.success) {
        throw new ToolDomainError('input_validation', parsed.error.message)
      }
      const result = await executeWebFetch(parsed.data, {
        abortSignal: ctx.abortSignal,
        tavilyKey: ctx.tavilyKey,
        jinaKey: ctx.jinaKey,
      })
      return createToolExecutionOutput(JSON.stringify(result), {
        data: result as unknown as Record<string, unknown>,
      })
    }
    case 'present_file': {
      const parsed = presentFileSchema.safeParse(args)
      if (!parsed.success) {
        throw new ToolDomainError('input_validation', parsed.error.message)
      }
      const result = await executePresentFile(parsed.data, {
        abortSignal: ctx.abortSignal,
        sessionId: ctx.sessionId,
        outputsRoot: ctx.outputsRoot,
        requestModuleToolAction: ctx.requestModuleToolAction,
      })
      return createToolExecutionOutput(JSON.stringify(result), {
        data: result as unknown as Record<string, unknown>,
      })
    }
    case 'web_clip_url': {
      const parsed = webClipUrlSchema.safeParse(args)
      if (!parsed.success) {
        throw new ToolDomainError('input_validation', parsed.error.message)
      }
      if (!ctx.obsidianWebClipPresetDir) {
        throw new ToolDomainError(
          'clip_preset_render_failed',
          'preset directory not configured; ensure obsidian-web-clip skill is installed',
          { reason: 'preset_not_found' },
        )
      }
      const result = await executeWebClipUrl(parsed.data, {
        abortSignal: ctx.abortSignal,
        sessionId: ctx.sessionId,
        outputsRoot: ctx.outputsRoot,
        presetDir: ctx.obsidianWebClipPresetDir,
        jinaKey: ctx.jinaKey,
        requestModuleToolAction: ctx.requestModuleToolAction,
      })
      return createToolExecutionOutput(JSON.stringify(result), {
        data: result as unknown as Record<string, unknown>,
      })
    }
    default:
      throw new ToolDomainError(
        'tool_not_registered',
        `Unknown general_research tool: ${toolName}`,
      )
  }
}
