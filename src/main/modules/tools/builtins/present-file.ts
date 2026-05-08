/**
 * Stage R W6.4 — `present_file` tool implementation.
 *
 * Path arguments are validated against `<outputsRoot>` via
 * `resolveReadableWithinRoot` (skill-primitives/path-sandbox.ts), then
 * forwarded to the renderer through `requestModuleToolAction(
 * 'renderer:present-file', { path, reason })`. The renderer side wires
 * an attachment-style chip / preview surface.
 *
 * Sandboxing pattern matches `skill_read_artifact`: the same path-sandbox
 * helper is used so an absolute path passed back through the model is only
 * accepted when it still resolves under `<outputsRoot>`.
 *
 * Pure module — no electron, no skills-runtime imports.
 */

import { z } from 'zod'

import { ToolDomainError } from '../tool-errors'
import {
  PathSandboxError,
  resolveReadableWithinRoot,
} from '../skill-primitives/path-sandbox'

export const presentFileSchema = z.object({
  path: z.string().min(1).describe('要呈现给用户的文件路径；必须位于 outputs 目录内'),
  reason: z.string().optional().describe('呈现意图说明（可选），帮助用户理解为什么会看到这份文件'),
})

export type PresentFileArgs = z.infer<typeof presentFileSchema>

export interface PresentFileContext {
  abortSignal?: AbortSignal
  sessionId?: string
  outputsRoot: string
  requestModuleToolAction?: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
}

export interface PresentFileResult {
  status: 'presented'
  path: string
}

export async function executePresentFile(
  args: PresentFileArgs,
  ctx: PresentFileContext,
): Promise<PresentFileResult> {
  if (!ctx.outputsRoot) {
    throw new ToolDomainError('present_file_failed', 'outputsRoot is not configured for present_file')
  }
  let resolvedPath: string
  try {
    resolvedPath = resolveReadableWithinRoot(ctx.outputsRoot, args.path)
  } catch (error) {
    if (error instanceof PathSandboxError) {
      throw new ToolDomainError('path_outside_outputs', error.message, {
        reason: error.reason,
        outputsRoot: ctx.outputsRoot,
        requestedPath: args.path,
      })
    }
    // R1-M02: wrap any non-PathSandboxError (e.g. fs.realpath failures, ENOENT)
    // in a structured ToolDomainError so dispatch never sees a bare throw.
    throw new ToolDomainError(
      'present_file_failed',
      error instanceof Error ? error.message : String(error),
      {
        outputsRoot: ctx.outputsRoot,
        requestedPath: args.path,
      },
    )
  }

  if (!ctx.requestModuleToolAction) {
    throw new ToolDomainError('present_file_failed', 'renderer bridge (requestModuleToolAction) is not available')
  }

  try {
    await ctx.requestModuleToolAction('renderer:present-file', {
      path: resolvedPath,
      reason: args.reason ?? null,
      sessionId: ctx.sessionId ?? null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ToolDomainError('present_file_failed', `renderer rejected present-file: ${message}`, {
      path: resolvedPath,
    })
  }

  return { status: 'presented', path: resolvedPath }
}
