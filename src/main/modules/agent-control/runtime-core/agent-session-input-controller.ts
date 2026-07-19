import type { AgentInputItem } from '@openai/agents'
import type { DurableRequestAnchor } from '../../../../shared/browser-workflow-control'
import type { RequestEnvelope } from '../contracts/request-envelope'
import { parseEnvelopeResourceReferences } from './agent-sdk-input-context-utils'
import {
  AgentSessionCheckpointRepository,
  workflowDigest,
} from '../../repositories/agent-session-checkpoint-repository'
import type { ToolBridgeRuntimeContext } from './agent-sdk-types'

function browserRouteResourceAnchors(value: unknown): DurableRequestAnchor['resourceAnchors'] {
  const envelope = value && typeof value === 'object' && !Array.isArray(value)
    ? value as RequestEnvelope
    : null
  if (!envelope || !Array.isArray(envelope.resources)) return []
  return envelope.resources.map((resource) => ({
    resourceId: resource.id,
    kind: resource.kind,
    version: resource.widgetFingerprint || null,
    contentDigest: workflowDigest({
      text: resource.text,
      summary: resource.summary,
      widgetTextSample: resource.widgetTextSample || null,
    }),
    provenanceDigest: workflowDigest({
      source: resource.source,
      name: resource.name,
      path: resource.path,
      documentPath: resource.documentPath || null,
      tabId: resource.tabId || null,
      widgetId: resource.widgetId || null,
      canRead: resource.canRead,
      canWrite: resource.canWrite,
    }),
  }))
}

function exactPrefixDigest(
  items: readonly AgentInputItem[],
  count: number,
): string | null {
  if (count < 0 || count > items.length) return null
  return workflowDigest(items.slice(0, count))
}

function hasExactPrefix(
  prefix: readonly AgentInputItem[],
  items: readonly AgentInputItem[],
): boolean {
  if (prefix.length > items.length) return false
  return workflowDigest(prefix) === workflowDigest(items.slice(0, prefix.length))
}

function steeringReceiptId(item: AgentInputItem): string | null {
  const providerData = (item as { providerData?: unknown }).providerData
  if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) return null
  const receipt = (providerData as Record<string, unknown>).readySteeringReceipt
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null
  const receiptId = (receipt as Record<string, unknown>).receiptId
  return typeof receiptId === 'string' && receiptId ? receiptId : null
}

function browserVerifierRecoveryFactId(item: AgentInputItem): string | null {
  const providerData = (item as { providerData?: unknown }).providerData
  if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) return null
  const fact = (providerData as Record<string, unknown>).readyBrowserVerifierRecovery
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return null
  const factId = (fact as Record<string, unknown>).factId
  return typeof factId === 'string' && factId ? factId : null
}

function observationFactActionSeq(item: AgentInputItem): number | null {
  const providerData = (item as { providerData?: unknown }).providerData
  if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) return null
  const fact = (providerData as Record<string, unknown>).readyBrowserObservationFact
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return null
  const sequence = Math.floor(Number((fact as Record<string, unknown>).actionSeq || 0))
  return Number.isInteger(sequence) && sequence > 0 ? sequence : null
}

function isConfirmedBrowserPowerFact(item: AgentInputItem): boolean {
  const providerData = (item as { providerData?: unknown }).providerData
  if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) return false
  const receipt = (providerData as Record<string, unknown>).readyBrowserPowerConfirmation
  return Boolean(
    receipt
    && typeof receipt === 'object'
    && !Array.isArray(receipt)
    && (receipt as Record<string, unknown>).decision === 'confirmed',
  )
}

function isConfirmedBrowserPermissionFact(item: AgentInputItem): boolean {
  const providerData = (item as { providerData?: unknown }).providerData
  if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) return false
  const receipt = (providerData as Record<string, unknown>).readyBrowserPermissionConfirmation
  return Boolean(
    receipt
    && typeof receipt === 'object'
    && !Array.isArray(receipt)
    && (receipt as Record<string, unknown>).decision === 'confirmed',
  )
}

function browserObservationFactItem(
  barrier: ToolBridgeRuntimeContext['browserObservationGaps'][number],
): AgentInputItem {
  const fact = {
    contract: 'ready_browser_action_observation_v1',
    actionId: barrier.actionId,
    actionSeq: barrier.actionSeq,
    operationId: barrier.operationId,
    outcome: barrier.outcome,
    mayHaveCommitted: barrier.outcome.mayHaveCommitted === true,
    requiresFreshObservation: barrier.clearedByObservationSeq === null,
    clearingObservationSeq: barrier.clearedByObservationSeq,
    replayAllowed: false,
  }
  return {
    role: 'system',
    content: `Browser workflow observation fact: ${JSON.stringify(fact)}`,
    providerData: { readyBrowserObservationFact: fact },
  } as AgentInputItem
}

function appendWithoutDuplicateDurableFacts(
  base: readonly AgentInputItem[],
  suffix: readonly AgentInputItem[],
): AgentInputItem[] {
  const result = structuredClone(base) as AgentInputItem[]
  const steeringIds = new Set(result.map(steeringReceiptId).filter((id): id is string => Boolean(id)))
  const verifierFactIds = new Set(result
    .map(browserVerifierRecoveryFactId)
    .filter((id): id is string => Boolean(id)))
  for (const item of suffix) {
    const receiptId = steeringReceiptId(item)
    const verifierFactId = browserVerifierRecoveryFactId(item)
    if (receiptId && steeringIds.has(receiptId)) continue
    if (verifierFactId && verifierFactIds.has(verifierFactId)) continue
    result.push(structuredClone(item) as AgentInputItem)
    if (receiptId) steeringIds.add(receiptId)
    if (verifierFactId) verifierFactIds.add(verifierFactId)
  }
  return result
}

/**
 * Owner-local provider input controller. Before a Browser workflow is bound it
 * is a zero-write pass-through. After binding, every changed clean model
 * boundary advances a durable SDK-source cursor and atomically consumes Parent
 * steering receipts. The public/shared SDK MemorySession is never touched.
 */
export class AgentSessionInputController {
  private latestProviderBoundary: {
    compactedItems: AgentInputItem[]
    sourceItems: AgentInputItem[]
    compacted: boolean
    finalItems: AgentInputItem[]
  } | null = null

  constructor(
    private readonly repository: AgentSessionCheckpointRepository,
    private readonly runtimeContext: ToolBridgeRuntimeContext,
    private readonly requestEnvelope: unknown,
  ) {}

  latestFilteredInput(): AgentInputItem[] | null {
    return this.latestProviderBoundary
      ? structuredClone(this.latestProviderBoundary.finalItems) as AgentInputItem[]
      : null
  }

  async ensureBrowserWorkflowRoute(): Promise<{
    browserTaskId: string
    requestAnchorSnapshotDigest: string
  }> {
    if (this.runtimeContext.browserWorkflowRoute) return this.runtimeContext.browserWorkflowRoute
    const executionBinding = this.runtimeContext.executionBinding
    if (!executionBinding) throw new Error('browser_route_execution_binding_required')
    const bound = await this.repository.bindBrowserWorkflowRoute({
      parentTaskId: this.runtimeContext.taskId,
      ownerRunId: this.runtimeContext.runId,
      sourceMessageId: this.runtimeContext.sourceMessageId,
      executionBinding,
      resourceAnchors: browserRouteResourceAnchors(this.requestEnvelope),
    })
    this.runtimeContext.preparedSkillTurn = {
      ...this.runtimeContext.preparedSkillTurn,
      requestOrResourceAnchorDigest: bound.requestAnchorSnapshotDigest,
    }
    const route = {
      browserTaskId: bound.browserTaskId,
      requestAnchorSnapshotDigest: bound.requestAnchorSnapshotDigest,
    }
    this.runtimeContext.browserWorkflowRoute = route
    await this.persistLatestCleanBoundary()
    return route
  }

  async persistLatestCleanBoundary(): Promise<AgentInputItem[]> {
    const boundary = this.latestProviderBoundary
    if (!boundary) throw new Error('browser_route_clean_boundary_missing')
    return this.filter(boundary.compactedItems, {
      sourceItems: boundary.sourceItems,
      compacted: boundary.compacted,
    })
  }

  async persistSuspension(
    reason: 'budget' | 'steering' | 'incomplete' | 'background' | 'foreground' | 'provider_transfer' | 'manual',
    recoveryItems: readonly AgentInputItem[] = [],
  ) {
    const route = this.runtimeContext.browserWorkflowRoute
    if (!route || !this.runtimeContext.activatedCapabilityGroups.includes('browser')) {
      throw new Error('browser_workflow_route_required_for_suspension')
    }
    const boundary = this.latestProviderBoundary
    if (!boundary) throw new Error('browser_route_clean_boundary_missing')
    const cleanInput = await this.resolveFinalBase(
      boundary.compactedItems,
      {
        sourceItems: boundary.sourceItems,
        compacted: boundary.compacted,
      },
    )
    const suspensionInput = appendWithoutDuplicateDurableFacts(cleanInput, recoveryItems)
    return this.repository.writeCleanBoundary({
      parentTaskId: this.runtimeContext.taskId,
      browserTaskId: route.browserTaskId,
      ownerRunId: this.runtimeContext.runId,
      role: 'suspension',
      suspensionReason: reason,
      sourceItems: suspensionInput,
      sdkSourceItems: boundary.sourceItems,
      sdkSourceItemCount: boundary.sourceItems.length,
      sdkSourcePrefixDigest: workflowDigest(boundary.sourceItems),
      lastEffectiveBrowserActionSeq: this.runtimeContext.lastEffectiveBrowserActionSeq,
      requiredOperationIds: this.runtimeContext.browserRequiredOperationIds,
      preparedSkill: this.runtimeContext.preparedSkillTurn,
      activatedCapabilityGroups: this.runtimeContext.activatedCapabilityGroups,
      resourceRefs: parseEnvelopeResourceReferences(this.requestEnvelope).resources
        .map((resource) => String(resource.path || resource.name || resource.kind || '').trim())
        .filter(Boolean),
    })
  }

  async filter(
    compactedItems: AgentInputItem[],
    context: { sourceItems: AgentInputItem[]; compacted: boolean },
  ): Promise<AgentInputItem[]> {
    const route = this.runtimeContext.browserWorkflowRoute
    if (!route || !this.runtimeContext.activatedCapabilityGroups.includes('browser')) {
      this.latestProviderBoundary = {
        compactedItems: structuredClone(compactedItems) as AgentInputItem[],
        sourceItems: structuredClone(context.sourceItems) as AgentInputItem[],
        compacted: context.compacted,
        finalItems: structuredClone(compactedItems) as AgentInputItem[],
      }
      return compactedItems
    }

    const sourceItems = structuredClone(context.sourceItems) as AgentInputItem[]
    const finalBase = await this.resolveFinalBase(compactedItems, context)
    const current = this.repository.current(this.runtimeContext.taskId, 'clean_base')
    if (
      current
      && !this.runtimeContext.browserSuspensionRequest
      && !this.repository.hasPendingSteering(this.runtimeContext.taskId)
      && workflowDigest(finalBase) === current.finalInputDigest
      && current.sdkSourceItemCount === sourceItems.length
      && current.sdkSourcePrefixDigest === workflowDigest(sourceItems)
      && current.preparedSkill.requestOrResourceAnchorDigest
        === this.runtimeContext.preparedSkillTurn.requestOrResourceAnchorDigest
      && current.lastEffectiveBrowserActionSeq
        === this.runtimeContext.lastEffectiveBrowserActionSeq
      && workflowDigest(current.requiredOperationIds)
        === workflowDigest(this.runtimeContext.browserRequiredOperationIds)
    ) {
      this.latestProviderBoundary = {
        compactedItems: structuredClone(compactedItems) as AgentInputItem[],
        sourceItems,
        compacted: context.compacted,
        finalItems: structuredClone(current.finalInput) as AgentInputItem[],
      }
      return current.finalInput
    }

    const suspensionRequest = this.runtimeContext.browserSuspensionRequest
    const checkpoint = await this.repository.writeCleanBoundary({
      parentTaskId: this.runtimeContext.taskId,
      browserTaskId: route.browserTaskId,
      ownerRunId: this.runtimeContext.runId,
      role: this.runtimeContext.browserSuspensionRequest ? 'suspension' : 'clean_base',
      sourceItems: finalBase,
      sdkSourceItems: sourceItems,
      sdkSourceItemCount: sourceItems.length,
      sdkSourcePrefixDigest: workflowDigest(sourceItems),
      lastEffectiveBrowserActionSeq: this.runtimeContext.lastEffectiveBrowserActionSeq,
      requiredOperationIds: this.runtimeContext.browserRequiredOperationIds,
      preparedSkill: this.runtimeContext.preparedSkillTurn,
      activatedCapabilityGroups: this.runtimeContext.activatedCapabilityGroups,
      takeoverId: suspensionRequest?.kind === 'human_takeover' ? suspensionRequest.takeoverId : undefined,
      suspensionRequest: suspensionRequest?.kind === 'browser_power_confirmation'
        || suspensionRequest?.kind === 'browser_permission'
        ? suspensionRequest
        : undefined,
      suspensionReason: suspensionRequest
        ? suspensionRequest.kind === 'human_takeover'
          ? 'human_takeover'
          : suspensionRequest.kind
        : undefined,
      resourceRefs: parseEnvelopeResourceReferences(this.requestEnvelope).resources
        .map((resource) => String(resource.path || resource.name || resource.kind || '').trim())
        .filter(Boolean),
    })
    this.latestProviderBoundary = {
      compactedItems: structuredClone(compactedItems) as AgentInputItem[],
      sourceItems,
      compacted: context.compacted,
      finalItems: structuredClone(checkpoint.finalInput) as AgentInputItem[],
    }
    if (this.runtimeContext.browserSuspensionRequest) {
      const error = new Error('browser_workflow_suspended_after_tool_result')
      error.name = 'BrowserWorkflowSuspendedError'
      throw error
    }
    return checkpoint.finalInput
  }

  private async resolveFinalBase(
    compactedItems: AgentInputItem[],
    context: { sourceItems: AgentInputItem[]; compacted: boolean },
  ): Promise<AgentInputItem[]> {
    const sourceItems = structuredClone(context.sourceItems) as AgentInputItem[]
    const current = this.repository.current(this.runtimeContext.taskId, 'clean_base')
    let finalBase: AgentInputItem[]
    if (!current) {
      finalBase = structuredClone(compactedItems) as AgentInputItem[]
    } else {
      const storedCursorMatches = exactPrefixDigest(
        sourceItems,
        current.sdkSourceItemCount,
      ) === current.sdkSourcePrefixDigest
      const checkpointSeedMatches = hasExactPrefix(current.finalInput, sourceItems)
      if (!storedCursorMatches && !checkpointSeedMatches) {
        throw new Error('owner_local_session_source_cursor_mismatch')
      }
      const suffix = checkpointSeedMatches
        ? sourceItems.slice(current.finalInput.length)
        : sourceItems.slice(current.sdkSourceItemCount)
      if (context.compacted) {
        const durableFactItems = current.finalInput.filter((item) => (
          steeringReceiptId(item) || browserVerifierRecoveryFactId(item)
        ))
        finalBase = appendWithoutDuplicateDurableFacts(compactedItems, durableFactItems)
      } else {
        finalBase = appendWithoutDuplicateDurableFacts(current.finalInput, suffix)
      }
    }

    finalBase = finalBase.filter((item) => observationFactActionSeq(item) === null)
    for (const observationGap of this.runtimeContext.browserObservationGaps) {
      finalBase.push(browserObservationFactItem(observationGap))
    }
    if (this.runtimeContext.confirmedBrowserPowerRequestConsumed) {
      finalBase = finalBase.filter((item) => !isConfirmedBrowserPowerFact(item))
    }
    if (this.runtimeContext.confirmedBrowserPermissionRequestConsumed) {
      finalBase = finalBase.filter((item) => !isConfirmedBrowserPermissionFact(item))
    }
    return finalBase
  }
}
