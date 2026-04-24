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
}

export type ToolExecutionResultLike = string | ToolExecutionOutput

export function createToolExecutionOutput(
  text: string,
  options?: {
    shape?: ToolResultShape
    data?: Record<string, unknown> | null
    projectionPatch?: Record<string, unknown> | null
    interactionHint?: ToolInteractionHint | null
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
  }
}

export function getToolExecutionText(output: ToolExecutionResultLike): string {
  return normalizeToolExecutionOutput(output).text
}

export function serializeToolExecutionOutput(output: ToolExecutionResultLike): string {
  const normalized = normalizeToolExecutionOutput(output)
  // B Phase 4 PR3: prefer `text` when both `text` and `projectionPatch`
  // are set. Previously a non-empty patch unconditionally won and the
  // model saw the UI-oriented JSON as the tool_result body — fine for
  // workflow skills (where "execution state" WAS the result) but
  // misleading for primitive tool calls (where the model needs stdout or
  // an ask_user answer). Patches remain the UI-facing projection source;
  // the tool_result body stays stdout-shaped.
  if (normalized.text) {
    return normalized.text
  }
  if (normalized.projectionPatch) {
    return JSON.stringify(normalized.projectionPatch)
  }
  if (normalized.shape === 'json' && normalized.data) {
    return JSON.stringify(normalized.data)
  }
  return ''
}
