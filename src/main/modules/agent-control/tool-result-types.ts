import type { TurnFramePatch } from './turn-frame'

export type ToolResultShape = 'text' | 'json' | 'projection_patch'

export type ToolInteractionHint =
  | 'awaiting_confirmation'
  | 'awaiting_clarification'

export interface ToolExecutionOutput {
  text: string
  shape: ToolResultShape
  data: Record<string, unknown> | null
  projectionPatch: Record<string, unknown> | null
  interactionHint: ToolInteractionHint | null
  /**
   * Stage 5 — optional structured updates a tool can return to mutate the
   * next iteration's TurnFrame (active artifact roots, validated config,
   * discovered task handles, liveness hints). Null when the tool didn't
   * surface any frame-level change. The turn engine merges patches across
   * a batch and applies them deterministically.
   */
  framePatch: TurnFramePatch | null
}

export type ToolExecutionResultLike = string | ToolExecutionOutput

export function createToolExecutionOutput(
  text: string,
  options?: {
    shape?: ToolResultShape
    data?: Record<string, unknown> | null
    projectionPatch?: Record<string, unknown> | null
    interactionHint?: ToolInteractionHint | null
    framePatch?: TurnFramePatch | null
  },
): ToolExecutionOutput {
  const projectionPatch = options?.projectionPatch || null
  const data = options?.data || null
  const shape = options?.shape
    || (projectionPatch ? 'projection_patch' : data ? 'json' : 'text')

  return {
    text,
    shape,
    data,
    projectionPatch,
    interactionHint: options?.interactionHint || null,
    framePatch: options?.framePatch || null,
  }
}

export function normalizeToolExecutionOutput(output: ToolExecutionResultLike): ToolExecutionOutput {
  if (typeof output === 'string') {
    return createToolExecutionOutput(output)
  }

  return {
    text: typeof output.text === 'string' ? output.text : '',
    shape: output.shape || (output.projectionPatch ? 'projection_patch' : output.data ? 'json' : 'text'),
    data: output.data && typeof output.data === 'object' ? output.data : null,
    projectionPatch: output.projectionPatch && typeof output.projectionPatch === 'object' ? output.projectionPatch : null,
    interactionHint: output.interactionHint || null,
    framePatch: output.framePatch && typeof output.framePatch === 'object' ? output.framePatch : null,
  }
}

export function getToolExecutionText(output: ToolExecutionResultLike): string {
  return normalizeToolExecutionOutput(output).text
}

export function serializeToolExecutionOutput(output: ToolExecutionResultLike): string {
  const normalized = normalizeToolExecutionOutput(output)
  if (normalized.text) {
    return normalized.text
  }
  if (normalized.projectionPatch) {
    return JSON.stringify(normalized.projectionPatch)
  }
  if (normalized.shape === 'json' && normalized.data && !normalized.text) {
    return JSON.stringify(normalized.data)
  }
  return normalized.text
}
