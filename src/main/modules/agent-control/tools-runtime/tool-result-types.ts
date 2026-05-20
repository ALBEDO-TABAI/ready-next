import type { TurnFramePatch } from '../turn-frame'
import type { SkillRunContract } from '../run-contracts'

export type ToolResultShape = 'text' | 'json' | 'projection_patch'

export type ToolInteractionHint =
  | 'awaiting_confirmation'
  | 'awaiting_clarification'

/**
 * Phase 3 (skill-child-loop) — same-turn live update emitted by a tool so
 * dependent later tools in the SAME batch can read the fresh artifact roots
 * / handles / contract without rebuilding a TurnFrame. Applied by
 * `applyContextModifier` (in `tool-runtime.ts`) immediately after the tool
 * result is normalized.
 *
 * Coexists with `framePatch`: the frame patch is the durable end-of-turn
 * persistence path; `contextModifier` is the additive intra-turn signal.
 * A tool may emit either, both, or neither.
 */
export interface ToolExecutionContextModifier {
  activeFrame?: {
    activeArtifactRoots?: string[]
    runContract?: SkillRunContract | null
    discoveredHandles?: Record<string, unknown>[]
  }
  /**
   * Reserved for future intra-turn signals (e.g. live progress updates,
   * supervisor liveness flips). Intentionally untyped here so Phase 3
   * keeps the shape minimal — extension hooks land with their consumers.
   */
}

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
  /**
   * Phase 3 (skill-child-loop) — same-turn live frame update for dependent
   * later tools in the same batch. Optional; null/undefined for tools that
   * don't mutate cross-tool context.
   */
  contextModifier?: ToolExecutionContextModifier | null
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
    contextModifier?: ToolExecutionContextModifier | null
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
    contextModifier: options?.contextModifier || null,
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
    contextModifier: output.contextModifier && typeof output.contextModifier === 'object' ? output.contextModifier : null,
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
