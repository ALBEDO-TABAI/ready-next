import type { SidecarManager } from '../sidecar-manager'
import type { AgentControlRuntime } from '../runtime-core/runtime'
import type { ConversationScope } from '../contracts/types'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { AgentSpawnContext } from '../../../../shared/skill-host-contract'
import type { SpecialistBlueprintSourceMessageUnavailableReason } from '../../../../shared/agent-specialist-blueprint'
import type { TurnFeatureFlags } from '../runtime-core/turn-feature-flags'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type { SkillRunContract } from '../contracts/run-contracts'
import type { ToolExecutionOutput } from './tool-result-types'

/**
 * Phase 3 (skill-child-loop) — live, same-turn slice of the active TurnFrame
 * exposed to dependent later tools in the same batch. Where the durable
 * `framePatch` flows through the end-of-turn persistence path, this slot is
 * mutated by `applyContextModifier` immediately after each tool result is
 * normalized so the next dependent tool in the same iteration sees the fresh
 * artifact roots / handles without having to rebuild a TurnFrame.
 *
 * Shape is intentionally minimal in Phase 3 — only the three signals the
 * upcoming child runner needs:
 *   - `activeArtifactRoots`: read-only paths that `skill_read_artifact`
 *     should treat as additional allowed roots for the rest of the turn.
 *   - `runContract`: the latest `SkillRunContract` snapshot (or null) so
 *     consumers can check status / liveness without re-entering the loader.
 *   - `discoveredHandles`: opaque per-tool handle records (taskRunId,
 *     detachedTaskId, jobId, runStatePath, …) that later tools can read
 *     without the LLM having to repeat the discovery call.
 *
 * Always populated (never undefined). Empty defaults stand in when the
 * builder has no frame snapshot — see `tool-runtime-context-builder.ts`.
 */
export interface ToolRuntimeActiveFrameContext {
  activeArtifactRoots: string[]
  runContract: SkillRunContract | null
  discoveredHandles: Record<string, unknown>[]
}

export interface ToolRuntimeContext {
  browserController?: BrowserController | null
  sidecarManager?: SidecarManager | null
  runtime?: AgentControlRuntime | null
  scope?: ConversationScope | null
  agent?: string | null
  allowedToolNames?: Set<string> | string[] | null
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  abortSignal?: AbortSignal
  /** EP2-I2 — standing user negation families (dispatch interception). */
  activeNegations?: ReadonlyArray<string>
  sessionId?: string
  scopeId?: string
  currentUserText?: string
  sourceMessageId?: string | null
  sourceMessageUnavailableReason?: SpecialistBlueprintSourceMessageUnavailableReason | null
  requestEnvelope?: unknown
  runId?: string
  taskId?: string
  parentTaskId?: string
  parentStepId?: string
  taskProjectionId?: string
  frameSkillId?: string | null
  registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
  agentContext?: AgentSpawnContext | null
  turnFeatureFlags?: TurnFeatureFlags
  /**
   * Phase 3 — same-turn live frame slot (see `ToolRuntimeActiveFrameContext`).
   * Mutated by `applyContextModifier` between tool calls within the same
   * batch. The end-of-turn persistence path (frame patch) is unchanged.
   */
  activeFrame: ToolRuntimeActiveFrameContext
  /**
   * Per-turn skill tool authorization (required).
   */
  authorization: SkillToolAuthorization
}

/**
 * Build the empty default `ToolRuntimeActiveFrameContext`. Used by the
 * context builder cold path and by `applyContextModifier` when the caller
 * passes a context lacking the slot (e.g. legacy tests).
 */
export function createEmptyActiveFrameContext(): ToolRuntimeActiveFrameContext {
  return {
    activeArtifactRoots: [],
    runContract: null,
    discoveredHandles: [],
  }
}

/**
 * Phase 3 — apply a tool result's `contextModifier.activeFrame` to the
 * runtime context's `activeFrame` slot, BEFORE the next dependent tool runs.
 *
 * Semantics:
 *   - `activeArtifactRoots`: union with existing list (deduplicated, order
 *     preserved by first appearance). New roots appended last.
 *   - `runContract`: last-write-wins; null leaves the existing contract.
 *   - `discoveredHandles`: appended.
 *
 * The mutation is in-place so downstream tools that read `context.activeFrame`
 * see the update without having to rebuild the runtime context.
 */
export function applyContextModifier(
  context: ToolRuntimeContext | null | undefined,
  output: ToolExecutionOutput | null | undefined,
): void {
  if (!context || !output) return
  const modifier = output.contextModifier
  if (!modifier || !modifier.activeFrame) return

  if (!context.activeFrame) {
    context.activeFrame = createEmptyActiveFrameContext()
  }

  const patch = modifier.activeFrame

  if (Array.isArray(patch.activeArtifactRoots) && patch.activeArtifactRoots.length > 0) {
    const seen = new Set<string>(context.activeFrame.activeArtifactRoots)
    for (const root of patch.activeArtifactRoots) {
      if (typeof root !== 'string') continue
      const trimmed = root.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      context.activeFrame.activeArtifactRoots.push(trimmed)
    }
  }

  if (patch.runContract !== undefined && patch.runContract !== null) {
    context.activeFrame.runContract = patch.runContract
  }

  if (Array.isArray(patch.discoveredHandles) && patch.discoveredHandles.length > 0) {
    for (const handle of patch.discoveredHandles) {
      if (handle && typeof handle === 'object' && !Array.isArray(handle)) {
        context.activeFrame.discoveredHandles.push(handle as Record<string, unknown>)
      }
    }
  }
}
