import { MemorySession, type AgentInputItem } from '@openai/agents'
import {
  browserDocumentIdentityCompatible,
  isCompleteBrowserIdentity,
  isNoDocumentBrowserIdentity,
} from '../../../../shared/browser-action-outcome'
import { BROWSER_OPERATION_IDS } from '../../../../shared/browser-capability-registry'
import { BROWSER_POWER_EFFECTS } from '../../../../shared/browser-power'
import { BROWSER_PUBLIC_TOOL_NAMES } from '../../../../shared/browser-tool-surface'
import type {
  BrowserPermissionSuspensionRequest,
  BrowserPowerConfirmationSuspensionRequest,
} from '../../../../shared/browser-workflow-control'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import type { RunHandle, ToolBridgeRuntimeContext } from './agent-sdk-types'
import { getInteractionLifecycleRegistry } from './interaction-lifecycle-registry'

const BROWSER_OPERATION_ID_SET = new Set<string>(BROWSER_OPERATION_IDS)
const BROWSER_POWER_EFFECT_SET = new Set<string>(BROWSER_POWER_EFFECTS)

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseBrowserPowerSuspensionRequest(
  value: unknown,
  context: Pick<ToolBridgeRuntimeContext, 'runId' | 'sessionId' | 'browserWorkflowRoute'>,
): BrowserPowerConfirmationSuspensionRequest | null {
  const request = asPlainRecord(value)
  const actionIntent = asPlainRecord(request?.actionIntent)
  const target = asPlainRecord(request?.target)
  const effects = Array.isArray(request?.effects) ? request.effects : []
  if (
    request?.version !== 1
    || request.kind !== 'browser_power_confirmation'
    || request.wakeKind !== 'browser_power_confirmation'
    || (request.toolName !== 'browser_eval' && request.toolName !== 'browser_cdp')
    || typeof request.requestId !== 'string'
    || !request.requestId.trim()
    || effects.length === 0
    || effects.some((effect) => typeof effect !== 'string' || !BROWSER_POWER_EFFECT_SET.has(effect))
    || !actionIntent
    || typeof actionIntent.objectRef !== 'string'
    || !actionIntent.objectRef.trim()
    || typeof actionIntent.inputHash !== 'string'
    || !actionIntent.inputHash.trim()
    || !target
    || target.ownerRunId !== context.runId
    || target.browserTaskId !== context.browserWorkflowRoute?.browserTaskId
    || target.scopeId !== context.sessionId
    || (target.tabId !== null && (typeof target.tabId !== 'string' || !target.tabId.trim()))
    || typeof target.documentKeyHash !== 'string'
    || !target.documentKeyHash.trim()
    || typeof target.targetDigest !== 'string'
    || !target.targetDigest.trim()
    || (target.origin !== null && typeof target.origin !== 'string')
    || typeof request.purpose !== 'string'
  ) return null
  return structuredClone(request) as unknown as BrowserPowerConfirmationSuspensionRequest
}

function confirmedBrowserPowerRequestFromItems(
  items: readonly AgentInputItem[],
): BrowserPowerConfirmationSuspensionRequest | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const providerData = (items[index] as { providerData?: unknown }).providerData
    const receipt = asPlainRecord(asPlainRecord(providerData)?.readyBrowserPowerConfirmation)
    if (receipt?.decision !== 'confirmed') continue
    const request = asPlainRecord(receipt.request)
    if (
      request?.version === 1
      && request.kind === 'browser_power_confirmation'
      && request.wakeKind === 'browser_power_confirmation'
      && typeof request.requestId === 'string'
      && (request.toolName === 'browser_eval' || request.toolName === 'browser_cdp')
    ) return structuredClone(request) as unknown as BrowserPowerConfirmationSuspensionRequest
  }
  return null
}

function parseBrowserPermissionSuspensionRequest(
  value: unknown,
  context: Pick<ToolBridgeRuntimeContext, 'runId' | 'sessionId' | 'browserWorkflowRoute'>,
): BrowserPermissionSuspensionRequest | null {
  const request = asPlainRecord(value)
  const actionIntent = asPlainRecord(request?.actionIntent)
  const target = asPlainRecord(request?.target)
  if (
    request?.version !== 1
    || request.kind !== 'browser_permission'
    || request.wakeKind !== 'browser_permission'
    || request.toolName !== 'browser_permission'
    || typeof request.requestId !== 'string'
    || !request.requestId.trim()
    || request.purpose !== 'site_permission_request'
    || !actionIntent
    || typeof actionIntent.siteRequestId !== 'string'
    || !actionIntent.siteRequestId.trim()
    || typeof actionIntent.permission !== 'string'
    || !actionIntent.permission.trim()
    || typeof actionIntent.origin !== 'string'
    || !actionIntent.origin.trim()
    || (actionIntent.decision !== 'allow' && actionIntent.decision !== 'deny')
    || typeof actionIntent.inputHash !== 'string'
    || !actionIntent.inputHash.trim()
    || !target
    || target.ownerRunId !== context.runId
    || target.browserTaskId !== context.browserWorkflowRoute?.browserTaskId
    || target.scopeId !== context.sessionId
    || typeof target.tabId !== 'string'
    || !target.tabId.trim()
    || typeof target.targetDigest !== 'string'
    || !target.targetDigest.trim()
  ) return null
  return structuredClone(request) as unknown as BrowserPermissionSuspensionRequest
}

function confirmedBrowserPermissionRequestFromItems(
  items: readonly AgentInputItem[],
): BrowserPermissionSuspensionRequest | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const providerData = (items[index] as { providerData?: unknown }).providerData
    const receipt = asPlainRecord(asPlainRecord(providerData)?.readyBrowserPermissionConfirmation)
    if (receipt?.decision !== 'confirmed') continue
    const request = asPlainRecord(receipt.request)
    if (
      request?.version === 1
      && request.kind === 'browser_permission'
      && request.wakeKind === 'browser_permission'
      && request.toolName === 'browser_permission'
      && typeof request.requestId === 'string'
    ) return structuredClone(request) as unknown as BrowserPermissionSuspensionRequest
  }
  return null
}

function observationCoversGap(
  receipt: Record<string, unknown>,
  gap: ToolBridgeRuntimeContext['browserObservationGaps'][number],
  ownerRunId: string,
): boolean {
  if (String(receipt.ownerRunId || '') !== ownerRunId) return false
  const outcomeIdentity = asPlainRecord(gap.outcome.identity)
  const successorIdentity = asPlainRecord(gap.outcome.successorIdentity)
  if (!outcomeIdentity || !isCompleteBrowserIdentity(successorIdentity)) return false
  const predecessorCompatible = (candidate: unknown): boolean =>
    browserDocumentIdentityCompatible(candidate, outcomeIdentity)
    || (
      gap.operationId === 'tabs_open'
      && isNoDocumentBrowserIdentity(candidate)
      && isNoDocumentBrowserIdentity(outcomeIdentity)
    )
  const causalActions = Array.isArray(receipt.causalActions) ? receipt.causalActions : []
  const linked = causalActions.some((value) => {
    const action = asPlainRecord(value)
    return Boolean(
      action
      && action.actionId === gap.actionId
      && Math.floor(Number(action.actionSeq || 0)) === gap.actionSeq
      && predecessorCompatible(action.predecessorIdentity)
      && browserDocumentIdentityCompatible(action.successorIdentity, successorIdentity)
    )
  })
  return linked
    && isCompleteBrowserIdentity(receipt.identity)
    && browserDocumentIdentityCompatible(receipt.identity, successorIdentity)
}

function outcomeRequiresObservation(outcome: Record<string, unknown>): boolean {
  return !(
    outcome.mayHaveCommitted === false
    && (outcome.dispatch === 'rejected' || outcome.delivery === 'not_delivered')
  ) && (outcome.needsObservation === true || outcome.mayHaveCommitted === true)
}

type BrowserRuntimeFields = Pick<ToolBridgeRuntimeContext,
  | 'browserRequiredOperationIds'
  | 'lastEffectiveBrowserActionSeq'
  | 'browserWorkflowRoute'
  | 'browserObservationGaps'
  | 'browserObservationBarrier'
  | 'browserSuspensionRequest'
  | 'confirmedBrowserPowerRequest'
  | 'confirmedBrowserPowerRequestConsumed'
  | 'confirmedBrowserPermissionRequest'
  | 'confirmedBrowserPermissionRequestConsumed'
  | 'activatedCapabilityGroups'>

export async function prepareBrowserWorkflowTurnState(input: {
  runtime: TurnOrchestratorHost['runtime']
  capturedSession: RunHandle['capturedSession']
  taskId: string
  runId: string
  sessionId?: string
  browserSurfaceActive: boolean
}): Promise<{
  ownerSessionSeed: AgentInputItem[]
  ownerLocalSession: MemorySession
  runtimeFields: BrowserRuntimeFields
}> {
  const repository = input.runtime?.getAgentSessionCheckpointRepository?.() || null
  const restored = repository?.current(input.taskId, 'suspension')
    || repository?.current(input.taskId, 'clean_base')
    || null
  const ownerSessionSeed = restored
    ? structuredClone(restored.finalInput)
    : structuredClone(await input.capturedSession.getItems())
  const ownerLocalSession = new MemorySession({
    sessionId: `${input.sessionId || input.taskId}:owner:${input.runId}`,
    initialItems: ownerSessionSeed,
  })
  const gaps = repository && restored
    ? repository.readBrowserObservationGaps(input.taskId)
    : []
  const observationGaps = gaps.map((gap) => ({
    ...gap,
    clearedByObservationSeq: null,
  }))
  return {
    ownerSessionSeed,
    ownerLocalSession,
    runtimeFields: {
      browserRequiredOperationIds: [...new Set([
        ...(restored?.requiredOperationIds || []),
        ...gaps.map((gap) => gap.operationId),
      ])].filter((operationId) => BROWSER_OPERATION_ID_SET.has(operationId)).sort(),
      lastEffectiveBrowserActionSeq: restored?.lastEffectiveBrowserActionSeq || 0,
      browserWorkflowRoute: restored?.browserTaskId
        ? {
            browserTaskId: restored.browserTaskId,
            requestAnchorSnapshotDigest: restored.preparedSkill.requestOrResourceAnchorDigest,
          }
        : null,
      browserObservationGaps: observationGaps,
      browserObservationBarrier: observationGaps[0] ?? null,
      browserSuspensionRequest: null,
      confirmedBrowserPowerRequest: confirmedBrowserPowerRequestFromItems(ownerSessionSeed),
      confirmedBrowserPowerRequestConsumed: false,
      confirmedBrowserPermissionRequest: confirmedBrowserPermissionRequestFromItems(ownerSessionSeed),
      confirmedBrowserPermissionRequestConsumed: false,
      activatedCapabilityGroups: input.browserSurfaceActive ? ['browser'] : [],
    },
  }
}

type BrowserUnresolvedAction = {
  actionId: string
  actionSeq: number
  outcome: Record<string, unknown>
}

function observationGapFromAction(
  runtimeContext: ToolBridgeRuntimeContext,
  entry: BrowserUnresolvedAction,
): ToolBridgeRuntimeContext['browserObservationGaps'][number] {
  const outcome = entry.outcome
  const operationId = String(outcome.operationId || '')
  if (
    !runtimeContext.browserWorkflowRoute
    || entry.actionId !== outcome.actionId
    || entry.actionSeq !== Math.floor(Number(outcome.actionSeq || 0))
    || outcome.taskId !== runtimeContext.browserWorkflowRoute.browserTaskId
    || outcome.mode !== 'mutate'
    || !BROWSER_OPERATION_ID_SET.has(operationId)
    || !outcomeRequiresObservation(outcome)
  ) throw new Error('browser_observation_gap_invalid')
  return {
    actionId: entry.actionId,
    actionSeq: entry.actionSeq,
    operationId,
    outcome: structuredClone(outcome),
    clearedByObservationSeq: null,
  }
}

function refreshBrowserObservationBarrier(runtimeContext: ToolBridgeRuntimeContext): void {
  runtimeContext.browserObservationGaps = runtimeContext.browserObservationGaps
    .filter((gap) => gap.clearedByObservationSeq === null)
    .sort((left, right) => left.actionSeq - right.actionSeq)
  runtimeContext.browserObservationBarrier = runtimeContext.browserObservationGaps[0] ?? null
}

/** Replace the run-local view from the durable journal's unresolved actions. */
export function syncBrowserObservationGapsFromJournal(
  runtimeContext: ToolBridgeRuntimeContext,
  unresolvedActions: readonly BrowserUnresolvedAction[],
): void {
  runtimeContext.browserObservationGaps = unresolvedActions
    .map((entry) => observationGapFromAction(runtimeContext, entry))
  refreshBrowserObservationBarrier(runtimeContext)
}

export function recordBrowserWorkflowToolResult(
  runtimeContext: ToolBridgeRuntimeContext,
  toolName: string,
  structuredData: Record<string, unknown>,
): void {
  const operationId = typeof structuredData.operationId === 'string'
    && BROWSER_OPERATION_ID_SET.has(structuredData.operationId)
    ? structuredData.operationId
    : null
  if (operationId && !runtimeContext.browserRequiredOperationIds.includes(operationId)) {
    runtimeContext.browserRequiredOperationIds.push(operationId)
    runtimeContext.browserRequiredOperationIds.sort()
  }
  const actionOutcome = asPlainRecord(
    structuredData.browserActionOutcome || structuredData.outcome,
  )
  const actionSeq = Math.floor(Number(structuredData.actionSeq ?? actionOutcome?.actionSeq ?? 0))
  const actionOperationId = typeof actionOutcome?.operationId === 'string'
    ? actionOutcome.operationId
    : operationId
  const actionTaskId = typeof actionOutcome?.taskId === 'string'
    ? actionOutcome.taskId
    : runtimeContext.browserWorkflowRoute?.browserTaskId
  const actionOwnerRunId = typeof actionOutcome?.ownerRunId === 'string'
    ? actionOutcome.ownerRunId
    : runtimeContext.runId
  if (
    actionOperationId
    && BROWSER_OPERATION_ID_SET.has(actionOperationId)
    && actionOutcome
    && actionOutcome.mode === 'mutate'
    && Number.isInteger(actionSeq)
    && actionSeq > 0
    && actionTaskId === runtimeContext.browserWorkflowRoute?.browserTaskId
    && actionOwnerRunId === runtimeContext.runId
  ) {
    runtimeContext.lastEffectiveBrowserActionSeq = Math.max(
      runtimeContext.lastEffectiveBrowserActionSeq,
      actionSeq,
    )
    if (outcomeRequiresObservation(actionOutcome)) {
      const gap = observationGapFromAction(runtimeContext, {
        actionId: String(actionOutcome.actionId || ''),
        actionSeq,
        outcome: actionOutcome,
      })
      if (!runtimeContext.browserObservationGaps.some((item) => (
        item.actionId === gap.actionId && item.actionSeq === gap.actionSeq
      ))) runtimeContext.browserObservationGaps.push(gap)
      refreshBrowserObservationBarrier(runtimeContext)
    }
  }

  const observationReceipt = asPlainRecord(structuredData.browserObservationReceipt)
  const observationSeq = Math.floor(Number(observationReceipt?.observationSeq || 0))
  const observationBarrier = runtimeContext.browserObservationBarrier
  if (
    observationBarrier
    && observationBarrier.clearedByObservationSeq === null
    && operationId
    && observationReceipt
    && BROWSER_OPERATION_ID_SET.has(String(observationReceipt.operationId || ''))
    && observationCoversGap(observationReceipt, observationBarrier, runtimeContext.runId)
    && Number.isInteger(observationSeq)
    && observationSeq > 0
  ) {
    for (const gap of runtimeContext.browserObservationGaps) {
      if (
        gap.clearedByObservationSeq === null
        && observationCoversGap(observationReceipt, gap, runtimeContext.runId)
      ) gap.clearedByObservationSeq = observationSeq
    }
    refreshBrowserObservationBarrier(runtimeContext)
  }

  const powerSuspensionRequest = parseBrowserPowerSuspensionRequest(
    structuredData.browserSuspensionRequest,
    runtimeContext,
  )
  const permissionSuspensionRequest = parseBrowserPermissionSuspensionRequest(
    structuredData.browserSuspensionRequest,
    runtimeContext,
  )
  const confirmedPowerRequest = runtimeContext.confirmedBrowserPowerRequest
  if (
    confirmedPowerRequest
    && confirmedPowerRequest.toolName === toolName
    && !powerSuspensionRequest
    && structuredData.ok === true
  ) {
    runtimeContext.confirmedBrowserPowerRequest = null
    runtimeContext.confirmedBrowserPowerRequestConsumed = true
  }
  const confirmedPermissionRequest = runtimeContext.confirmedBrowserPermissionRequest
  if (
    confirmedPermissionRequest
    && toolName === 'browser_permission'
    && !permissionSuspensionRequest
    && structuredData.ok === true
  ) {
    runtimeContext.confirmedBrowserPermissionRequest = null
    runtimeContext.confirmedBrowserPermissionRequestConsumed = true
  }
  if (structuredData.suspendAfterToolResult !== true) return

  const takeoverId = typeof structuredData.takeoverId === 'string'
    ? structuredData.takeoverId.trim()
    : ''
  if (powerSuspensionRequest) {
    runtimeContext.browserSuspensionRequest = powerSuspensionRequest
    const lifecycle = getInteractionLifecycleRegistry()
    lifecycle.register({
      interactionId: powerSuspensionRequest.requestId,
      runId: runtimeContext.runId,
      agentId: runtimeContext.agentName,
      scopeId: runtimeContext.sessionId || runtimeContext.taskId,
      type: 'browser_confirmation',
    })
    lifecycle.settle({
      interactionId: powerSuspensionRequest.requestId,
      runId: runtimeContext.runId,
      agentId: runtimeContext.agentName,
      scopeId: runtimeContext.sessionId || runtimeContext.taskId,
      disposition: 'checkpoint',
    })
  } else if (permissionSuspensionRequest) {
    runtimeContext.browserSuspensionRequest = permissionSuspensionRequest
    const lifecycle = getInteractionLifecycleRegistry()
    lifecycle.register({
      interactionId: permissionSuspensionRequest.requestId,
      runId: runtimeContext.runId,
      agentId: runtimeContext.agentName,
      scopeId: runtimeContext.sessionId || runtimeContext.taskId,
      type: 'browser_confirmation',
    })
    lifecycle.settle({
      interactionId: permissionSuspensionRequest.requestId,
      runId: runtimeContext.runId,
      agentId: runtimeContext.agentName,
      scopeId: runtimeContext.sessionId || runtimeContext.taskId,
      disposition: 'checkpoint',
    })
  } else if (takeoverId) {
    runtimeContext.browserSuspensionRequest = { kind: 'human_takeover', takeoverId }
  } else {
    throw new Error('browser_suspension_request_invalid')
  }
}

export function browserSurfaceActiveForDefinitions(
  definitions: ReadonlyArray<{ name: string }>,
): boolean {
  return definitions.some((definition) => BROWSER_PUBLIC_TOOL_NAMES.includes(definition.name as never))
}
