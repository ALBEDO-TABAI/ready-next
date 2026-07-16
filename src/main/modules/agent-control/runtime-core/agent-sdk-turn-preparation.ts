import {
  classifyFollowupIntent,
  detectNegationReleases
} from '../../../../shared/agent-followup-intent'
import { classifyBrowserToolCall } from '../../browser-engine/browser-tool-write-classification'
import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'
import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import type { ExecutionTurnResult, RunMessage, TaskBudgetRuntime } from '../contracts/run-contracts'
import { logAgentMetric } from '../metrics'
import {
  authCategoriesForNegationFamilies,
  detectVerbatimGrants,
  recordVerbatimGrant,
  revokeAuthorizationsForCategories
} from '../safety/authorization-fact-store'
import { recordNegations, releaseNegations } from '../safety/negation-state'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type {
  CapabilityResolution,
  RequestedCapabilityConflict
} from '../domain-adapters/capability-resolver'
import { clearActivePlanForScope } from '../system-reminders/active-plan-step-reminder'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { createEmptyActiveFrameContext } from '../tools-runtime/tool-runtime'
import {
  hydrateDocumentTargetPreservation,
  resolveDocumentTargetGuard
} from './agent-sdk-document-utils'
import {
  errorMessage,
  shouldPreferCurrentDocumentRead,
  shouldRequireLocalDocumentExcerpt,
  shouldRequireLocalDocumentWriteOutput,
  shouldUseLocalDocumentToolSet
} from './agent-sdk-execution-utils'
import {
  hasLocalSendImIntentForTurn,
  isLocalSendImRetryFollowup,
  narrowToolSurfaceForLocalDocument,
  recoverEmptyToolSurface,
  restoreCheckpointToolSurface,
  shouldPreserveTaskIntentToolDuringDocumentNarrowing,
  stripMediaBlocksForLocalSendIm
} from './agent-sdk-foundation-utils'
import {
  messageToText,
  parseEnvelopeResourceReferences,
  primaryInstructionText
} from './agent-sdk-input-context-utils'
import {
  hasRecalledTaskContext,
  messageHasBrowserBatchCollectionIntent,
  messageHasExplicitBrowserCollectionIntent,
  readSkillReferenceNames,
  resolveSkillHintRelevanceForTurn
} from './agent-sdk-skill-intent-utils'
import type {
  AgentSdkBudgetCheckpointRestore,
  AgentSdkExecutionOptions,
  AgentSdkProviderDiagnostics,
  AgentSdkSkillCatalogSnapshotEntry,
  DocumentTargetGuard
} from './agent-sdk-types'
import type { TurnTerminalReason } from './turn-frame'
import { deriveChainedSkillReadRoots } from './turn-frame-resolver'

import type { TurnOrchestratorHost } from './agent-sdk-turn-context'

export type { TurnOrchestratorHost } from './agent-sdk-turn-context'

export interface AgentSdkTurnPreparationContext {
  host: TurnOrchestratorHost
  content: RunMessage
  effectiveExecutionOptions?: AgentSdkExecutionOptions
  checkpointRestore: AgentSdkBudgetCheckpointRestore | null
  activeFrame: ReturnType<typeof createEmptyActiveFrameContext>
  sessionId?: string
  runId: string
  taskId: string
  config: Parameters<TurnOrchestratorHost['listToolDefinitionsForTurn']>[0]['config']
  runMetaBudgetRuntime: TaskBudgetRuntime | null
  runMetaProviderDiagnostics: AgentSdkProviderDiagnostics | null
  emitOutput: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null
  ) => void
  finalizeEarlyReturn: (params: {
    status: 'done' | 'checkpoint' | 'error' | 'cancelled'
    terminalReason: TurnTerminalReason
    finalText: string
    error?: string
    continuationHandle?: string | null
    taskBudgetRuntime?: TaskBudgetRuntime | null
    providerDiagnostics?: AgentSdkProviderDiagnostics | null
    initiator?: string
  }) => Promise<ExecutionTurnResult>
}

export type AgentSdkTurnPreparationResult =
  | { terminalResult: Promise<ExecutionTurnResult> }
  | {
      terminalResult: null
      documentTargetHydration: Promise<void> | null
      skillCatalogSnapshot: AgentSdkSkillCatalogSnapshotEntry[]
      skillHintRelevanceForTurn: ReturnType<typeof resolveSkillHintRelevanceForTurn>
      authorization: SkillToolAuthorization
      documentTargetGuard: DocumentTargetGuard | null
      requiresLocalDocumentExcerpt: boolean
      preferCurrentDocumentRead: boolean
      requiresLocalDocumentWrite: boolean
      providerContent: RunMessage
      recentCollectionIntent: boolean
      requestedCapabilityConflicts: RequestedCapabilityConflict[]
      preNarrowingToolDefinitions: ToolDefinition[]
      toolDefinitions: ToolDefinition[]
      turnFollowup: ReturnType<typeof classifyFollowupIntent>
    }

export function prepareAgentSdkTurn(
  ctx: AgentSdkTurnPreparationContext
): AgentSdkTurnPreparationResult {
  const {
    host,
    content,
    effectiveExecutionOptions,
    checkpointRestore,
    activeFrame,
    sessionId,
    runId,
    taskId,
    config,
    runMetaBudgetRuntime,
    runMetaProviderDiagnostics,
    emitOutput,
    finalizeEarlyReturn
  } = ctx
  const currentLocalSendImTurn = hasLocalSendImIntentForTurn(
    content as RunMessage,
    effectiveExecutionOptions?.requestEnvelope
  )
  const recentLocalSendImTurn = host.intentTracker.trackLocalSendImIntent(
    sessionId,
    currentLocalSendImTurn
  )
  const localSendImTurn =
    currentLocalSendImTurn ||
    (recentLocalSendImTurn &&
      isLocalSendImRetryFollowup(content as RunMessage, effectiveExecutionOptions?.requestEnvelope))
  const scopeTaskRefs =
    host.getScopeTaskRefs && sessionId ? host.getScopeTaskRefs(sessionId) : undefined
  const skillHintRelevanceForTurn = resolveSkillHintRelevanceForTurn({
    message: content as RunMessage,
    sessionId,
    requestEnvelope: effectiveExecutionOptions?.requestEnvelope,
    orchestrator: host.skillContextOrchestrator,
    localSendImIntent: localSendImTurn,
    continuationIntent: effectiveExecutionOptions?.continuationIntent,
    continuationState: effectiveExecutionOptions?.continuationState,
    checkpointRestore,
    taskRefs: scopeTaskRefs
  })
  const authorization = host.resolveSkillAuthorizationForTurn(
    content as RunMessage,
    sessionId,
    effectiveExecutionOptions?.requestEnvelope,
    localSendImTurn,
    skillHintRelevanceForTurn.relevant
  )
  let skillCatalogSnapshot: AgentSdkSkillCatalogSnapshotEntry[] = []
  // R-XREAD — the live SDK path owns a lightweight active-frame context,
  // not the legacy TurnFrame resolver. Seed it here from typed envelope
  // siblings plus this exact task's prior output evidence.
  try {
    const manager = getSkillsRuntimeManager()
    const skills = manager.listSkills()
    skillCatalogSnapshot = skills
      .filter((skill) => skill && skill.id && skill.name && skill.manifestValid !== false)
      .map((skill) => ({
        id: String(skill.id),
        name: String(skill.name),
        description: String(skill.description || ''),
        managedPath: skill.managedPath
      }))
    const projection = host.runtime?.getTaskProjectionStoreForFinalize?.().get(taskId) ?? null
    const roots = deriveChainedSkillReadRoots({
      selectedSkillId: authorization.mode === 'selected' ? authorization.skillId : null,
      referencedSkillNames: readSkillReferenceNames(effectiveExecutionOptions?.requestEnvelope),
      skills,
      outputsRoot: manager.getRuntimeInfo().outputsRoot,
      taskProjection: projection
    })
    // R-XREAD — seed into the read-only channel, NOT activeArtifactRoots.
    // The write / export / handoff-target resolvers read activeArtifactRoots
    // only, so sibling read roots must never land there (else a sibling root
    // holding a pending handoff receipt would become writable).
    if (!activeFrame.activeReadOnlyRoots) activeFrame.activeReadOnlyRoots = []
    activeFrame.activeReadOnlyRoots.push(...roots.map((root) => root.path))
    if (roots.length > 0) {
      logAgentMetric('chained_skill_read_roots_seeded', {
        runId,
        taskId,
        siblingAssets: roots.filter((root) => root.kind === 'sibling_asset').length,
        siblingOutputs: roots.filter((root) => root.kind === 'sibling_output').length
      })
    }
  } catch (error) {
    logAgentMetric('chained_skill_read_roots_seed_failed', {
      runId,
      taskId,
      reason: errorMessage(error)
    })
  }
  const documentTargetGuard = resolveDocumentTargetGuard(
    content as RunMessage,
    effectiveExecutionOptions?.requestEnvelope
  )
  const documentTargetHydration = documentTargetGuard?.preserveExistingContent
    ? hydrateDocumentTargetPreservation(documentTargetGuard)
    : null
  const requiresLocalDocumentExcerpt = shouldRequireLocalDocumentExcerpt(
    content as RunMessage,
    effectiveExecutionOptions?.requestEnvelope
  )
  const preferCurrentDocumentRead = shouldPreferCurrentDocumentRead(
    content as RunMessage,
    effectiveExecutionOptions?.requestEnvelope
  )
  const requiresLocalDocumentWrite = shouldRequireLocalDocumentWriteOutput(
    content as RunMessage,
    effectiveExecutionOptions?.requestEnvelope
  )
  const providerContent = stripMediaBlocksForLocalSendIm(
    content as RunMessage,
    effectiveExecutionOptions?.requestEnvelope,
    localSendImTurn
  )
  const turnFollowupPrimary =
    parseEnvelopeResourceReferences(effectiveExecutionOptions?.requestEnvelope)
      .primaryInstruction || primaryInstructionText(content as RunMessage)
  const turnFollowup = classifyFollowupIntent(turnFollowupPrimary, {
    hasActiveTaskContext: hasRecalledTaskContext(messageToText(content as RunMessage)),
    taskRefs: scopeTaskRefs
  })
  // Synchronous continuity (no await in the run hot path): track this turn's
  // collection intent and decay the TTL so bare follow-ups stay exposed. A
  // substantive new task or explicit collection refusal starts a fresh intent
  // window instead of inheriting write tools from an unrelated prior turn.
  if (
    sessionId &&
    (
      localSendImTurn ||
      turnFollowup.kind === 'new_task' ||
      turnFollowup.negations.includes('collection')
    )
  ) {
    host.intentTracker.resetCollectionIntents(sessionId)
  }
  const recentCollectionIntent = host.intentTracker.trackCollectionIntent(
    sessionId,
    localSendImTurn
      ? false
      : messageHasExplicitBrowserCollectionIntent(
          content as RunMessage,
          effectiveExecutionOptions?.requestEnvelope
        )
  )
  const recentBatchCollectionIntent = host.intentTracker.trackBatchCollectionIntent(
    sessionId,
    localSendImTurn
      ? false
      : messageHasBrowserBatchCollectionIntent(
          content as RunMessage,
          effectiveExecutionOptions?.requestEnvelope
        )
  )
  const capabilityResolutionCapture: { current: CapabilityResolution | null } = { current: null }
  let toolDefinitions = host.listToolDefinitionsForTurn({
    message: content as RunMessage,
    sessionId,
    scopeId: sessionId,
    config: config,
    browserHostAvailable: host.hasBrowserController(),
    feishuConnected: host.runtime?.isChannelTypeAvailable?.('feishu-app') ?? false,
    // Phase I —— 渠道回传组仅对绑定了远程线程的 scope 暴露
    channelScopeBound: host.runtime?.isScopeChannelBound?.(sessionId) ?? false,
    authorization,
    recentCollectionIntent,
    recentBatchCollectionIntent,
    localSendImIntent: localSendImTurn,
    requestEnvelope: effectiveExecutionOptions?.requestEnvelope,
    // P2-2 — gate use_skill exposure on the exact per-turn catalog snapshot later shown to the model.
    skillCatalogAvailable: skillCatalogSnapshot.length > 0,
    onCapabilityResolution: (resolution) => { capabilityResolutionCapture.current = resolution }
  })
  const requestedCapabilityConflicts =
    capabilityResolutionCapture.current?.requestedButSuppressed || []
  if (requestedCapabilityConflicts.length > 0) {
    const groups = requestedCapabilityConflicts.map((conflict) => conflict.groupId).join('|')
    const reasons = requestedCapabilityConflicts.map((conflict) => conflict.reason).join('|')
    appendToolCapabilityLog(
      `[tool_capability] stage=requested_capability_conflict runId=${runId} groups=${groups} reasons=${reasons}`
    )
    logAgentMetric('tool_capability_conflict', { runId, taskId, scopeId: sessionId || null, groups, reasons })
  }
  const preNarrowingToolDefinitions = toolDefinitions
  if (
    shouldUseLocalDocumentToolSet(content as RunMessage, effectiveExecutionOptions?.requestEnvelope)
  ) {
    // P0-2(D2)：本地文档收窄不得吞掉技能选中轮的地板工具（否则 skill+doc 轮交集为空）。
    toolDefinitions = narrowToolSurfaceForLocalDocument(toolDefinitions, authorization, {
      preserveDefinition: shouldPreserveTaskIntentToolDuringDocumentNarrowing,
    })
  }
  // P0-2(T2)：空面回退紧跟本地文档收窄之后（先于 S4-2 status_query / documentTargetGuard /
  // checkpoint 收窄），保证这些安全/定向收窄始终在回退后的面上最后生效——回退永不撤销它们。
  const surfaceRecovery = recoverEmptyToolSurface(toolDefinitions, preNarrowingToolDefinitions)
  if (surfaceRecovery.recovered) {
    appendToolCapabilityLog(
      [
        '[tool_capability]',
        'stage=sdk_runtime_empty_surface_recovered',
        `restoredCount=${surfaceRecovery.definitions.length}`
      ].join(' ')
    )
    toolDefinitions = [...surfaceRecovery.definitions]
  }
  // S4-2: a status question ("怎么样了 / 还在跑吗") must report state, never
  // restart work. The guard is the tool surface itself (code-owned): browser
  // tools narrow to read-classified ones, so the model can browser_get_task
  // but cannot re-dispatch a collection. classifyBrowserToolCall fails
  // closed (unknown → write), which is exactly the conservative default.
  // EP2-I2 — standing negation lifecycle (session lineage): record fresh
  // negations from this turn; an explicit release signal ("现在可以采集
  // 了") lifts them. Dispatch-layer interception consults this state.
  if (sessionId) {
    if (turnFollowup.negations.length > 0) {
      recordNegations(sessionId, turnFollowup.negations)
      // EP2-I-auth: 拒绝权优先于既往批准 — negations revoke matching grants
      revokeAuthorizationsForCategories(
        sessionId,
        authCategoriesForNegationFamilies(turnFollowup.negations)
      )
    }
    const released = detectNegationReleases(turnFollowupPrimary)
    if (released.length > 0) releaseNegations(sessionId, released)
    // EP2-I-auth WRITE ENTRY 1 (classifier consumption chain): explicit
    // object+action naming in USER text becomes a provable grant.
    for (const grant of detectVerbatimGrants(turnFollowupPrimary)) {
      recordVerbatimGrant({
        scopeId: sessionId,
        actionCategory: grant.actionCategory,
        objectRef: grant.objectRef,
        verbatim: turnFollowupPrimary
      })
    }
  }
  // Review-team D3: a substantive NEW instruction supersedes the prior
  // plan — otherwise a stale "不要重新规划" reminder (within its TTL)
  // would steer the model against the user's new task.
  if (turnFollowup.kind === 'new_task' && turnFollowupPrimary.trim().length > 12) {
    clearActivePlanForScope(sessionId)
  }
  if (turnFollowup.kind === 'status_query') {
    toolDefinitions = toolDefinitions.filter((definition) => {
      const name = (definition as { name?: unknown }).name
      if (typeof name !== 'string' || !name.startsWith('browser_')) return true
      return classifyBrowserToolCall(name) === 'read'
    })
  }
  if (documentTargetGuard) {
    documentTargetGuard.openToolDefinition = toolDefinitions.find(
      (definition) => definition.name === 'document_open_tab'
    )
    documentTargetGuard.saveToolDefinition = toolDefinitions.find(
      (definition) => definition.name === 'document_save_tab'
    )
    toolDefinitions = toolDefinitions.filter((definition) => definition.name !== 'document_new_tab')
  }
  const restoredToolSurface = restoreCheckpointToolSurface({
    toolDefinitions,
    checkpointRestore,
    sessionId,
    scopeId: sessionId,
    authorization
  })
  toolDefinitions = restoredToolSurface.toolDefinitions
  if (restoredToolSurface.missingToolNames.length > 0) {
    const message = `续跑所需工具已经变化，无法安全继续：${restoredToolSurface.missingToolNames.join(', ')}`
    emitOutput(message, 'error')
    return {
      terminalResult: finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'blocked_tool_error',
        error: message,
        finalText: '',
        taskBudgetRuntime: runMetaBudgetRuntime,
        providerDiagnostics: runMetaProviderDiagnostics
      })
    }
  }

  return {
    terminalResult: null,
    documentTargetHydration,
    skillCatalogSnapshot,
    skillHintRelevanceForTurn,
    authorization,
    documentTargetGuard,
    requiresLocalDocumentExcerpt,
    preferCurrentDocumentRead,
    requiresLocalDocumentWrite,
    providerContent,
    recentCollectionIntent,
    requestedCapabilityConflicts,
    preNarrowingToolDefinitions,
    toolDefinitions,
    turnFollowup
  }
}
