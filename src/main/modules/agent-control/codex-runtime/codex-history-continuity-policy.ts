import type {
  CodexAcceptedNativePrefixHead,
  CodexNativeCoverageItem,
  CodexUncommittedUserTailItem,
} from './codex-binding-repository'
import type { PreparedCodexProductRun } from './codex-product-run-preparer'
import { digestCodexUserInput } from './codex-user-input'
import { digestCanonicalJson } from './codex-model-gateway-contract'

export function nativeInheritedContractDigest(input: {
  runtimeManifestDigest: string
  protocolSchemaDigest: string
  toolSurfaceSnapshotDigest: string
  instructionContractDigest: string
  model: string
  threadConfig: Record<string, unknown> | null
}): string {
  return digestCanonicalJson({
    contract: 'codex_native_inherited_contract_v1',
    historyPolicyVersion: 'codex_history_continuity_v1',
    ...input,
    modelProvider: 'ready_gateway',
    approvalPolicy: 'never',
    sandbox: 'read-only',
  })
}

export function classifyUncommittedOriginPolicy(input: {
  prepared: PreparedCodexProductRun
  executionEvidenceComplete: boolean
  toolCount: number
  actionCount: number
  interactionCount: number
  effectState: 'none' | 'confirmed' | 'indeterminate'
}): CodexUncommittedUserTailItem['policy'] {
  const { prepared } = input
  const ingress = prepared.ingress
  if (ingress.canonicalCurrentInputRef.input.some((item) => item.type !== 'text')
    || ingress.explicitResourceEnvelope.input.length > 0
    || ingress.explicitResourceEnvelope.resourceRefs.length > 0
    || ingress.resourceAdditionalContext.length > 0
    || ingress.currentDocumentAnchor || prepared.browserPageRef || prepared.externalReadSlice
    || prepared.resourceAuthorities?.length
    || Object.values(prepared.productSurfaceTargets || {}).some((target) => target != null)
    || prepared.sourceTrustedEnvironmentRef.workbenchMode === 'rss'
    || prepared.sourceTrustedEnvironmentRef.workbenchMode === 'calendar') {
    return 'resource_restatement_required'
  }
  if (prepared.readyTurnToolAuthorization.skillAuthorization.mode === 'selected'
    || prepared.actionObligations?.requirements.length || prepared.outputContract
    || (prepared.readyMemorySnapshot.enabled && prepared.readyMemorySnapshot.entries.length > 0)
    || !input.executionEvidenceComplete || input.toolCount > 0 || input.actionCount > 0
    || input.interactionCount > 0 || input.effectState !== 'none') {
    return 'task_restatement_required'
  }
  return 'untrusted_text_history'
}

/** Origins describe what entered native history, never the Retry control message. */
export function formalModelInputOrigins(prepared: PreparedCodexProductRun): CodexNativeCoverageItem[] {
  const ingress = prepared.ingress
  const delivered = new Set(ingress.uncommittedTailAssignments!
    .filter((assignment) => assignment.plan === 'deliver_untrusted_history')
    .map((assignment) => `${assignment.originUserMessageId}\0${assignment.inputDigest}`))
  const origins = (ingress.uncommittedUserTail || [])
    .filter((item) => delivered.has(`${item.originUserMessageId}\0${item.inputDigest}`))
    .map((item) => ({ messageId: item.originUserMessageId, digest: item.inputDigest }))
  origins.push({
    messageId: ingress.canonicalCurrentInputRef.messageId,
    digest: digestCodexUserInput(ingress.canonicalCurrentInputRef.input),
  })
  const unique = new Map<string, CodexNativeCoverageItem>()
  for (const origin of origins) {
    const previous = unique.get(origin.messageId)
    if (previous && previous.digest !== origin.digest) throw new Error('coverage_message_digest_conflict')
    unique.set(origin.messageId, origin)
  }
  return [...unique.values()]
}

export function resolveExplicitRetryTailPlan(
  tail: readonly CodexUncommittedUserTailItem[],
  root: { originUserMessageId: string; inputDigest: string } | undefined,
): { kind: 'eligible'; selected: CodexUncommittedUserTailItem; assignments: Array<{
  originUserMessageId: string
  inputDigest: string
  plan: 'deliver_untrusted_history' | 'replace_with_explicit_retry'
}> } | { kind: 'ineligible' } {
  const selected = tail.at(-1)
  if (!root || !selected || selected.originUserMessageId !== root.originUserMessageId
    || selected.inputDigest !== root.inputDigest
    || new Set(tail.map((item) => item.originUserMessageId)).size !== tail.length
    || tail.some((item) => item.policy !== 'untrusted_text_history')) return { kind: 'ineligible' }
  return {
    kind: 'eligible', selected,
    assignments: tail.map((item) => ({
      originUserMessageId: item.originUserMessageId, inputDigest: item.inputDigest,
      plan: item === selected ? 'replace_with_explicit_retry' : 'deliver_untrusted_history',
    })),
  }
}

export function resolveLiveUncommittedUserTail(input: {
  origins: readonly CodexUncommittedUserTailItem[]
  covered: ReadonlyMap<string, string>
  retainedInCurrentNative: ReadonlyMap<string, string>
  superseded: readonly { originUserMessageId: string; inputDigest: string; policy: string }[]
}): { handoffTail: CodexUncommittedUserTailItem[]; currentDeliveryTail: CodexUncommittedUserTailItem[] } {
  const origins = new Map<string, CodexUncommittedUserTailItem>()
  const policyRank = { untrusted_text_history: 0, task_restatement_required: 1, resource_restatement_required: 2 }
  for (const item of input.origins) {
    const previous = origins.get(item.originUserMessageId)
    if (previous && previous.inputDigest !== item.inputDigest) {
      throw new Error('uncommitted_user_tail_origin_conflict')
    }
    origins.set(item.originUserMessageId, previous && policyRank[previous.policy] > policyRank[item.policy]
      ? previous : item)
  }
  const superseded = new Map<string, string>()
  for (const item of input.superseded) {
    const origin = origins.get(item.originUserMessageId)
    if (!origin || origin.inputDigest !== item.inputDigest || origin.policy !== item.policy
      || origin.policy === 'untrusted_text_history') {
      throw new Error('uncommitted_user_tail_supersession_conflict')
    }
    superseded.set(item.originUserMessageId, item.inputDigest)
  }
  const result = [...origins.values()].filter((item) => {
    const coveredDigest = input.covered.get(item.originUserMessageId)
    if (coveredDigest && coveredDigest !== item.inputDigest) {
      throw new Error('uncommitted_user_tail_resolution_conflict')
    }
    return !coveredDigest && !superseded.has(item.originUserMessageId)
  })
  const currentDeliveryTail = result.filter((item) => {
    const retainedDigest = input.retainedInCurrentNative.get(item.originUserMessageId)
    if (retainedDigest && retainedDigest !== item.inputDigest) {
      throw new Error('uncommitted_user_tail_retention_conflict')
    }
    return !retainedDigest
  })
  return { handoffTail: result, currentDeliveryTail }
}

export type AcceptedNativePrefixResolution =
  | { kind: 'accepted'; head: CodexAcceptedNativePrefixHead }
  | { kind: 'proven_native_first_turn_no_prefix' }
  | { kind: 'unknown'; reason?: 'uncommitted_tail_budget_exceeded' }

export function resolveFormalNativeInputCoverage(input: {
  turns: readonly { nativeTurnId: string; origins: CodexNativeCoverageItem[] | null }[]
  provenPrefixTurnIds: ReadonlySet<string>
}): { kind: 'complete'; items: CodexNativeCoverageItem[] } | { kind: 'unknown' } {
  const unique = new Map<string, CodexNativeCoverageItem>()
  for (const turn of input.turns) {
    if (turn.origins === null) {
      if (!input.provenPrefixTurnIds.has(turn.nativeTurnId)) return { kind: 'unknown' }
      continue
    }
    for (const item of turn.origins) {
      const previous = unique.get(item.messageId)
      if (previous && previous.digest !== item.digest) throw new Error('coverage_message_digest_conflict')
      unique.set(item.messageId, item)
    }
  }
  return { kind: 'complete', items: [...unique.values()] }
}

export function resolveAcceptedNativePrefixHead(input: {
  legacy: boolean
  acceptedHead: CodexAcceptedNativePrefixHead | null
  currentRunId: string
  currentNativeTurnId: string | null
  productRunIds: readonly string[]
  manualCompactionCount: number
  orderedNativeTurnIds: readonly string[] | null
  nativeCompactionItemCount: number
  uncommittedOriginCount: number
}): AcceptedNativePrefixResolution {
  if (input.uncommittedOriginCount > 8) return { kind: 'unknown', reason: 'uncommitted_tail_budget_exceeded' }
  if (input.legacy || !input.currentNativeTurnId || !input.orderedNativeTurnIds
    || new Set(input.orderedNativeTurnIds).size !== input.orderedNativeTurnIds.length
    || input.orderedNativeTurnIds.at(-1) !== input.currentNativeTurnId) return { kind: 'unknown' }
  if (input.acceptedHead) {
    const index = input.orderedNativeTurnIds.indexOf(input.acceptedHead.acceptedNativeHeadId)
    return index >= 0 && index < input.orderedNativeTurnIds.length - 1
      ? { kind: 'accepted', head: input.acceptedHead }
      : { kind: 'unknown' }
  }
  return input.productRunIds.length === 1 && input.productRunIds[0] === input.currentRunId
    && input.manualCompactionCount === 0 && input.nativeCompactionItemCount === 0
    && input.orderedNativeTurnIds.length === 1
    ? { kind: 'proven_native_first_turn_no_prefix' }
    : { kind: 'unknown' }
}

export function assertNewCoverageItems(
  alreadyCoveredMessageIds: ReadonlySet<string>,
  items: readonly CodexNativeCoverageItem[],
): void {
  const current = new Set<string>()
  for (const item of items) {
    if (!item.messageId.trim() || !/^[a-f0-9]{64}$/.test(item.digest)) {
      throw new Error('coverage_item_invalid')
    }
    if (current.has(item.messageId)) throw new Error('coverage_item_duplicate')
    if (alreadyCoveredMessageIds.has(item.messageId)) {
      throw new Error('coverage_item_already_covered')
    }
    current.add(item.messageId)
  }
}
