import {
  compareReadyToolSurfaceCompatibility,
  type ReadyToolSurface,
  type ReadyToolSurfaceCompatibility,
} from './codex-tool-surface'
import type { RuntimeCompatibilitySet } from './codex-runtime-compatibility'
import { canonicalJson, digestCanonicalJson } from './codex-model-gateway-contract'
import { sameCodexThreadDirectory } from './codex-thread-directory-identity'

export type SameThreadContinuationReason =
  | 'runtime_unverified'
  | 'runtime_unsupported'
  | 'model_changed'
  | 'thread_config_changed'
  | 'cwd_unavailable'
  | 'cwd_changed'
  | 'instruction_contract_changed'
  | 'native_tool_surface_extension_required'
  | 'native_tool_definition_changed'
  | 'ready_tool_execution_contract_changed'
  // The live provider configuration cannot form a route at all. Blocks this
  // turn; it is not a statement about the stored history.
  | 'current_contract_read_failed'

export type StoredThreadContinuationContract = Readonly<{
  model: string
  threadConfig: Record<string, unknown> | null
  isolatedThreadCwd: string
  instructionContractDigest: string
  readyToolSurface: ReadyToolSurface
}>

export type SameThreadContinuationCandidate = Readonly<{
  model: string
  threadConfig: Record<string, unknown> | null
  isolatedThreadCwd: string
  cwdAvailable: boolean
  instructionContractDigest: string
  currentToolSurface: ReadyToolSurface
  toolCompatibility?: ReadyToolSurfaceCompatibility
}>

export type SameThreadContinuation = Readonly<{
  kind: 'ready_same_thread' | 'requires_new_context'
  reason: SameThreadContinuationReason | null
  evidenceDigest: string
  runtimeEvidenceDigest: string
  toolCompatibility: ReadyToolSurfaceCompatibility
}>

export function resolveSameThreadContinuationContract(input: {
  stored: StoredThreadContinuationContract
  candidate: SameThreadContinuationCandidate
  runtime: RuntimeCompatibilitySet
}): SameThreadContinuation {
  const toolCompatibility = input.candidate.toolCompatibility
    ?? compareReadyToolSurfaceCompatibility({
      frozen: input.stored.readyToolSurface,
      current: input.candidate.currentToolSurface,
    })
  const checks = {
    runtime: input.runtime.kind,
    modelMatches: input.stored.model === input.candidate.model,
    threadConfigMatches: canonicalJson(input.stored.threadConfig)
      === canonicalJson(input.candidate.threadConfig),
    cwdAvailable: input.candidate.cwdAvailable,
    cwdMatches: sameCodexThreadDirectory(
      input.stored.isolatedThreadCwd,
      input.candidate.isolatedThreadCwd,
    ),
    instructionMatches: input.stored.instructionContractDigest
      === input.candidate.instructionContractDigest,
    toolCompatibility,
  }
  let reason: SameThreadContinuation['reason'] = null
  if (input.runtime.kind === 'unsupported') reason = 'runtime_unsupported'
  else if (input.runtime.kind === 'unverified') reason = 'runtime_unverified'
  else if (!checks.modelMatches) reason = 'model_changed'
  else if (!checks.threadConfigMatches) reason = 'thread_config_changed'
  else if (!checks.cwdAvailable) reason = 'cwd_unavailable'
  else if (!checks.cwdMatches) reason = 'cwd_changed'
  else if (!checks.instructionMatches) reason = 'instruction_contract_changed'
  else if (toolCompatibility.kind !== 'compatible') reason = toolCompatibility.kind
  const kind = reason ? 'requires_new_context' as const : 'ready_same_thread' as const
  const unsigned = {
    contract: 'ready_same_thread_continuation_v1',
    kind,
    reason,
    runtimeEvidenceDigest: input.runtime.evidenceDigest,
    checks,
  }
  return {
    kind,
    reason,
    evidenceDigest: digestCanonicalJson(unsigned),
    runtimeEvidenceDigest: input.runtime.evidenceDigest,
    toolCompatibility,
  }
}
