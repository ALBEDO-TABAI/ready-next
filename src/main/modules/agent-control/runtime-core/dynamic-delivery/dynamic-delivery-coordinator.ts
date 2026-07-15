import { MemorySession, type AgentInputItem, type ModelProvider, type Tool as AgentSdkTool } from '@openai/agents'
import { createHash, randomBytes } from 'node:crypto'

import type { AgentExecutionProfile, TaskExecutionBinding } from '../../../../../shared/agent-execution-profile'
import {
  emptyDeliveryUsage,
  type AgentProfileSummary,
  type CollaborationDecision,
  type DeliveryMode,
  type DeliveryStateV1,
  type DispatchPlan,
  type WorkPackage,
} from '../../../../../shared/dynamic-delivery'
import type { TaskType } from '../../../../../shared/task-types'
import type { RequestEnvelope } from '../../contracts/request-envelope'
import type { TaskBudgetRuntime, TaskProjectionRecord } from '../../contracts/run-contracts'
import { compileDynamicDeliveryPlan } from '../../quality/packet-compiler'
import { dispatchDynamicDeliveryPackage } from '../../quality/packet-dispatch'
import type { WorkerReport } from '../../quality/worker-report'
import { createSubAgentCleanupHandle } from '../../sub-agent/sub-agent-cleanup'
import { runSubAgent } from '../../sub-agent/sub-agent-runner'
import { addRunUsage, type RunUsage } from '../run-usage-accumulator'
import type { ReadyAgentSdkRunParams, ReadyAgentSdkRunResult } from '../agent-sdk-types'
import { CandidateSessionTransaction } from './candidate-session-fork'
import { buildCanonicalDeliveryTaskFacts } from './canonical-task-facts'
import { decideDynamicDelivery } from './collaboration-policy'
import { buildDeliveryPreflightFacts } from './delivery-preflight'
import { DeliveryOutputBuffer } from './delivery-output-buffer'
import { classifyDeliveryRepair } from './delivery-repair-policy'
import { DeliveryRunContextStore } from './delivery-run-context'
import { deliveryAttemptIdentity, DynamicDeliveryTaskStore } from './dynamic-delivery-task-store'
import { DynamicDeliveryPacketScheduler } from './packet-scheduler'
import { sealDeliveryCandidate, type SealedDeliveryCandidate } from './seal-delivery-candidate'
import { SpecialistModelSubAgent, type WorkerExecutionResult } from './specialist-model-subagent'
import { verifyDeliveryCandidate, type DeliveryVerificationVerdict } from './delivery-verifier'
import type { VerifierResourceBundle } from './verifier-resource-bundle'
import type { WorkerResourceBundle } from './worker-resource-bundle'
import { logAgentMetric } from '../../metrics'
import { isRegisteredContributionAdoptable } from './contribution-receipt'
import { createDeliveryEvidenceIssuer } from '../../quality/delivery-evidence-issuer'
import { validateDeliveryEvidenceHandle } from '../../quality/delivery-evidence-validator'

interface IntentFacts {
  domains: string[] | null
  unknown: boolean
}

function narrowIntentClassification(value: unknown): IntentFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { domains: null, unknown: true }
  const record = value as Record<string, unknown>
  const confidence = typeof record.confidence === 'number' ? record.confidence : 1
  const primary = typeof record.primaryDomain === 'string' && record.primaryDomain !== 'generic'
    ? record.primaryDomain
    : null
  const mentioned = Array.isArray(record.mentionedDomains)
    ? record.mentionedDomains.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    : []
  return {
    domains: [...new Set([...(primary ? [primary] : []), ...mentioned])],
    unknown: confidence < 0.5,
  }
}

export function extractDynamicDeliveryEnvelopeFacts(value: unknown): {
  envelope: RequestEnvelope | null
  contextRefIds: string[] | null
  structuredTargetIds: string[] | null
  groundedWorkerResourceCount: number | null
  selectedSkillId: string | null
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { envelope: null, contextRefIds: null, structuredTargetIds: null, groundedWorkerResourceCount: null, selectedSkillId: null }
  }
  const envelope = value as RequestEnvelope
  if (!Array.isArray(envelope.resources) || !Array.isArray(envelope.referencedResources)) {
    return { envelope: null, contextRefIds: null, structuredTargetIds: null, groundedWorkerResourceCount: null, selectedSkillId: null }
  }
  const resourceIds = envelope.resources.map((resource) => resource.id).filter(Boolean)
  const referenced = envelope.referencedResources.map((resource) => resource.value).filter(Boolean)
  const explicitMentionNames = new Set(
    envelope.referencedResources
      .filter((resource) => resource.kind === 'mention')
      .map((resource) => resource.value.normalize('NFC').trim().toLowerCase())
      .filter(Boolean),
  )
  const selectedSkill = envelope.resources.find((resource) => resource.kind === 'skill_reference')
  return {
    envelope,
    contextRefIds: [...new Set([...resourceIds, ...referenced])],
    structuredTargetIds: envelope.resources
      .filter((resource) =>
        resource.kind !== 'skill_reference'
        && explicitMentionNames.has(String(resource.name || '').normalize('NFC').trim().toLowerCase()),
      )
      .map((resource) => resource.id)
      .filter(Boolean),
    groundedWorkerResourceCount: envelope.resources.filter((resource) =>
      resource.kind !== 'skill_reference'
      && resource.canRead
      && explicitMentionNames.has(String(resource.name || '').normalize('NFC').trim().toLowerCase())
      && String(resource.text || resource.summary || '').trim().length >= 80,
    ).length,
    selectedSkillId: selectedSkill?.name ? String(selectedSkill.name) : null,
  }
}

function workerBundle(envelope: RequestEnvelope | null, allowedRefs: readonly string[]): WorkerResourceBundle {
  const allowed = new Set(allowedRefs)
  const resources = (envelope?.resources ?? [])
    .filter((resource) => allowed.has(resource.id) && resource.canRead)
    .map((resource) => ({
      refId: resource.id,
      digest: resource.summary || resource.id,
      provenance: `${resource.kind}:${resource.source}`,
      excerpt: String(resource.text || resource.summary || '').slice(0, 2400),
    }))
  return { version: 1, resources, ownerArtifactSummaries: [], skillMethodSummary: null }
}

function stableParentGeneration(runId: string): number {
  let hash = 2166136261
  for (let index = 0; index < runId.length; index += 1) {
    hash ^= runId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export interface DynamicDeliveryCoordinatorAdapter {
  getProjection(taskId: string): TaskProjectionRecord | null
  updateProjection(taskId: string, patch: Partial<TaskProjectionRecord>): void
  taskStore(): DynamicDeliveryTaskStore
  listProfiles(): AgentProfileSummary[]
  resolveProfile(agentId: string): Promise<AgentExecutionProfile>
  createRegisteredBinding(input: {
    profile: AgentExecutionProfile
    runId: string
    ownerAgentIdAtStart: string
  }): TaskExecutionBinding
}

export interface PrepareDynamicDeliveryInput {
  mode: DeliveryMode
  runId: string
  taskId: string
  scopeId: string | null
  userRequestVerbatim: string
  ownerSystemPrompt: string
  requestEnvelope: unknown
  intentClassification: unknown
  inferredTaskType: TaskType
  liveBudget: TaskBudgetRuntime | null
  ownerBinding: TaskExecutionBinding | null
  ownerProfile: AgentExecutionProfile | null
  committedSession: MemorySession
  model: string
  provider: ModelProvider
  contextWindowTokens: number
  maxOutputTokens: number
  signal: AbortSignal
}

export interface PreparedDynamicDelivery {
  decision: CollaborationDecision
  ownerSession: MemorySession
  ownerReminder: string | null
  emitOutput: DeliveryOutputBuffer | null
  usage: RunUsage | null
}

export class DynamicDeliveryCoordinator {
  readonly contexts = new DeliveryRunContextStore()
  private readonly evidenceIssuer = createDeliveryEvidenceIssuer({ secret: randomBytes(32).toString('hex') })

  constructor(
    private readonly adapter: DynamicDeliveryCoordinatorAdapter,
    private readonly runAgent: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>,
  ) {}

  private persistNextState(
    context: NonNullable<ReturnType<DeliveryRunContextStore['get']>>,
    next: DeliveryStateV1,
  ): DeliveryStateV1 {
    const previous = context.state
    const persisted = this.adapter.taskStore().reduceState({
      taskId: context.taskId,
      parentGeneration: previous.parentGeneration,
      expectedStateRevision: previous.stateRevision,
      reduce: () => next,
    })
    context.state = persisted
    return persisted
  }

  async prepareOwnerInput(input: PrepareDynamicDeliveryInput): Promise<PreparedDynamicDelivery> {
    const projection = this.adapter.getProjection(input.taskId)
    const intent = narrowIntentClassification(input.intentClassification)
    const envelope = extractDynamicDeliveryEnvelopeFacts(input.requestEnvelope)
    const canonical = buildCanonicalDeliveryTaskFacts({
      taskType: projection?.taskType ?? input.inferredTaskType,
      intentDomains: intent.domains,
      structuredTargetIds: envelope.structuredTargetIds,
      contextRefIds: envelope.contextRefIds,
      signalConflict: intent.unknown,
    })
    const profiles = this.adapter.listProfiles()
    const thorough = input.mode === 'thorough'
    const facts = buildDeliveryPreflightFacts({
      mode: input.mode,
      taskType: canonical.taskType,
      intentDomains: canonical.hasUnknownRequiredFact ? null : canonical.intentDomains,
      structuredTargetIds: canonical.hasUnknownRequiredFact ? null : canonical.structuredTargetIds,
      groundedWorkerResourceCount: canonical.hasUnknownRequiredFact ? null : envelope.groundedWorkerResourceCount,
      contextRefIds: canonical.hasUnknownRequiredFact ? null : canonical.contextRefIds,
      selectedSkillId: envelope.selectedSkillId,
      risk: canonical.taskType === 'browser_transaction' ? 'exclusive_action' : 'ordinary',
      profiles,
      hostCriteria: projection?.criteria ? [projection.criteria] : [],
      budget: {
        totalRunTokenLimit: thorough ? 120_000 : 72_000,
        ownerReservedTokens: thorough ? 48_000 : 36_000,
        remainingTokens: thorough ? 120_000 : 72_000,
        remainingWallClockMs: thorough ? 240_000 : 120_000,
      },
    })
    let decision = decideDynamicDelivery(facts)
    logAgentMetric('dynamic_delivery_decision', {
      runId: input.runId,
      taskId: input.taskId,
      mode: input.mode,
      decision,
    })
    let plan: DispatchPlan | null = null
    let accumulatedUsage: RunUsage | null = null
    if (decision === 'support_and_verify') {
      try {
        plan = await compileDynamicDeliveryPlan({
          mode: input.mode === 'thorough' ? 'thorough' : 'adaptive',
          userRequestVerbatim: input.userRequestVerbatim,
          canonicalContextRefIds: canonical.contextRefIds,
          profiles,
        }, async ({ prompt }) => {
          const result = await this.runAgent({
            agentName: 'dynamic-delivery-planner',
            runId: `${input.runId}:planner`,
            taskId: input.taskId,
            sessionId: `${input.runId}:planner`,
            input: prompt,
            instructions: 'Return only the bounded DispatchPlan JSON.',
            model: input.model,
            provider: input.provider,
            session: new MemorySession({ sessionId: `${input.runId}:planner` }),
            tools: [],
            signal: input.signal,
            maxTurns: 1,
            contextWindowTokens: input.contextWindowTokens,
            maxOutputTokens: input.maxOutputTokens,
            onTextDelta: () => undefined,
          })
          accumulatedUsage = addRunUsage(accumulatedUsage, result.usage)
          return result.finalText
        })
      } catch (error) {
        if (input.signal.aborted) {
          throw input.signal.reason ?? error
        }
        // silent-catch: planner failure deterministically falls back to verifier-only delivery
        logAgentMetric('dynamic_delivery_fallback', {
          runId: input.runId,
          taskId: input.taskId,
          reason: 'planner_invalid_or_failed',
        })
        decision = 'verify_only'
        plan = null
      }
    }

    const initialState: DeliveryStateV1 = {
      version: 1,
      stateRevision: 0,
      decision,
      parentGeneration: stableParentGeneration(input.runId),
      packages: [],
      verifier: { status: decision === 'single_path' ? 'not_required' : 'pending', repaired: false },
      usage: emptyDeliveryUsage(),
    }
    if (decision === 'single_path') {
      if (projection) this.adapter.updateProjection(input.taskId, { deliveryState: initialState })
      return { decision, ownerSession: input.committedSession, ownerReminder: null, emitOutput: null, usage: accumulatedUsage }
    }
    logAgentMetric('dynamic_delivery_fired', { runId: input.runId, taskId: input.taskId, mode: input.mode, decision })

    const transaction = await CandidateSessionTransaction.create(input.committedSession, `${input.runId}:candidate`)
    const outputBuffer = new DeliveryOutputBuffer()
    const context = this.contexts.create({
      runId: input.runId,
      taskId: input.taskId,
      userRequestVerbatim: input.userRequestVerbatim,
      ownerSystemPrompt: input.ownerSystemPrompt,
      decision,
      state: initialState,
      committedSession: input.committedSession,
      ownerSession: transaction.workingSession,
      transaction,
      outputBuffer,
      workerReports: [],
      canonicalReceiptItems: [],
      evidenceResources: [],
    })
    if (accumulatedUsage) context.usage.add(accumulatedUsage)

    if (decision === 'support_and_verify' && plan && projection && input.ownerBinding) {
      await this.prepareSupportPackages({ input, projection, plan, context, envelope: envelope.envelope })
    } else if (projection) {
      this.adapter.updateProjection(input.taskId, { deliveryState: initialState })
    }
    return {
      decision,
      ownerSession: transaction.workingSession,
      ownerReminder: context.workerReports.length
        ? `\n[Dynamic Delivery verified support reports]\n${JSON.stringify(context.workerReports)}\n`
        : null,
      emitOutput: outputBuffer,
      usage: context.usage.snapshot(),
    }
  }

  private async prepareSupportPackages(params: {
    input: PrepareDynamicDeliveryInput
    projection: TaskProjectionRecord
    plan: DispatchPlan
    context: NonNullable<ReturnType<DeliveryRunContextStore['get']>>
    envelope: RequestEnvelope | null
  }): Promise<void> {
    const packageInputs: Array<{
      workPackage: WorkPackage
      profile: AgentExecutionProfile | null
      binding: TaskExecutionBinding
      childTaskId: string
      lifecycleId: string
    }> = []
    for (const workPackage of params.plan.packages) {
      const identity = deliveryAttemptIdentity({
        parentTaskId: params.projection.taskId,
        parentGeneration: params.context.state.parentGeneration,
        packageId: workPackage.packageId,
        attempt: 0,
      })
      let profile: AgentExecutionProfile | null = null
      let binding: TaskExecutionBinding
      if (workPackage.executorHint.kind === 'registered_agent') {
        profile = await this.adapter.resolveProfile(workPackage.executorHint.agentId)
        binding = this.adapter.createRegisteredBinding({
          profile,
          runId: identity.lifecycleId,
          ownerAgentIdAtStart: params.projection.ownerAgentId || params.input.ownerBinding!.ownerAgentIdAtStart,
        })
      } else {
        binding = {
          schemaVersion: 1,
          runId: identity.lifecycleId,
          ownerAgentIdAtStart: params.projection.ownerAgentId || params.input.ownerBinding!.ownerAgentIdAtStart,
          runOrigin: 'workflow_participant',
          kind: 'ephemeral',
          ephemeralRole: workPackage.executorHint.role,
          executionMaterialHash: `ephemeral:${workPackage.executorHint.role}:v1`,
          ownerAssignmentSource: 'parent_task',
          executionSelectionSource: 'ephemeral_role',
          resolutionKind: 'direct',
        }
      }
      packageInputs.push({ workPackage, profile, binding, ...identity })
    }
    params.context.state = {
      ...params.context.state,
      packages: packageInputs.map((entry) => ({
        packageId: entry.workPackage.packageId,
        attempt: 0,
        childTaskId: entry.childTaskId,
        lifecycleId: entry.lifecycleId,
        binding: entry.binding,
        criticality: entry.workPackage.criticality,
        status: 'running',
        adoptedByOwner: null,
        evidenceHandleIds: [],
      })),
    }
    this.adapter.taskStore().createPacketTree({
      parent: params.projection,
      deliveryState: params.context.state,
      packages: params.plan.packages,
      buildChild: ({ workPackage, childTaskId, lifecycleId }) => {
        const entry = packageInputs.find((candidate) => candidate.workPackage.packageId === workPackage.packageId)!
        const now = new Date().toISOString()
        return {
          taskId: childTaskId,
          scopeId: params.projection.scopeId,
          runId: lifecycleId,
          parentTaskId: params.projection.taskId,
          parentStepId: null,
          taskType: 'short_task',
          module: 'dynamic-delivery',
          taskTitle: workPackage.title,
          taskSummary: workPackage.objective,
          status: 'running',
          interactionState: 'running',
          waitingFor: 'none',
          steps: [],
          ownerAgentId: params.projection.ownerAgentId,
          taskOrigin: 'workflow_child',
          executionBinding: entry.binding,
          packetRole: 'child',
          contextRefs: workPackage.contextRefIds,
          createdAt: now,
          updatedAt: now,
        }
      },
    })

    const scheduler = new DynamicDeliveryPacketScheduler({ parentSignal: params.input.signal })
    for (const entry of packageInputs) {
      scheduler.schedule(entry.workPackage.packageId, async (signal) => {
        const dispatched = await dispatchDynamicDeliveryPackage({
          workPackage: entry.workPackage,
          binding: entry.binding,
          userRequestVerbatim: params.input.userRequestVerbatim,
          contextRefIds: entry.workPackage.contextRefIds,
          executeModelSubagent: async () => {
            const subagentName = entry.profile?.name
              ?? (entry.workPackage.executorHint.kind === 'ephemeral'
                ? `dynamic-${entry.workPackage.executorHint.role}`
                : 'dynamic-participant')
            const subagent = new SpecialistModelSubAgent(
              entry.lifecycleId,
              subagentName,
              {
                userRequestVerbatim: params.input.userRequestVerbatim,
                workPackage: entry.workPackage,
                binding: entry.binding,
                profile: entry.profile,
                ephemeralRole: entry.workPackage.executorHint.kind === 'ephemeral' ? entry.workPackage.executorHint.role : null,
                resourceBundle: workerBundle(params.envelope, entry.workPackage.contextRefIds),
              },
              {
                runAgent: this.runAgent,
                provider: params.input.provider,
                model: params.input.model,
                contextWindowTokens: params.input.contextWindowTokens,
                maxOutputTokens: params.input.maxOutputTokens,
              },
            )
            const iterator = runSubAgent(subagent, {
              abortSignal: signal,
              cleanup: createSubAgentCleanupHandle(entry.lifecycleId),
              permissionMode: 'restricted',
              parentScopeId: params.projection.scopeId,
              parentSessionId: params.input.scopeId,
              userRequestVerbatim: params.input.userRequestVerbatim,
              contextRefs: entry.workPackage.contextRefIds,
            })
            let close: Awaited<ReturnType<typeof iterator.next>>['value'] | null = null
            while (true) {
              const next = await iterator.next()
              if (next.done) { close = next.value; break }
            }
            const execution = (close as { metadata?: { workerExecution?: WorkerExecutionResult } } | null)?.metadata?.workerExecution
            if (!execution) throw new Error('delivery_worker_report_invalid')
            return execution
          },
        })
        return dispatched.result
      })
    }
    const results = await scheduler.awaitAll()
    for (const result of results) {
      const packageState = params.context.state.packages.find((entry) => entry.packageId === result.packageId)
      if (!packageState) continue
      packageState.status = result.status === 'fulfilled' ? 'completed' : packageState.criticality === 'required' ? 'blocked' : 'degraded'
      const childFailureReason = result.status === 'fulfilled'
        ? null
        : result.status === 'capacity_exceeded'
          ? result.reason
          : result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
      this.adapter.updateProjection(packageState.childTaskId, {
        status: result.status === 'fulfilled' ? 'completed' : 'failed',
        interactionState: 'suspended',
        waitingFor: 'none',
        blockedReason: childFailureReason,
        degradationReason: childFailureReason,
        updatedAt: new Date().toISOString(),
      })
      if (result.status === 'fulfilled') {
        const execution = result.value as WorkerExecutionResult
        const canonicalRef = execution.report.deliverable.resourceRefId
          ? `resource:${execution.report.deliverable.resourceRefId}`
          : `task_event:${packageState.childTaskId}`
        const excerpt = execution.report.deliverable.inline
          ?? execution.report.summaryLines.join('\n')
        const handle = this.evidenceIssuer.issue({
          childTaskId: packageState.childTaskId,
          canonicalRef,
          kind: execution.report.deliverable.resourceRefId ? 'resource' : 'task_event',
          digest: createHash('sha256').update(excerpt).digest('hex'),
          previewLocator: `delivery:${packageState.packageId}`,
        })
        validateDeliveryEvidenceHandle({
          handle,
          expectedChildTaskId: packageState.childTaskId,
          issuer: this.evidenceIssuer,
          isCanonicalRefReachable: (ref) => ref === canonicalRef,
        })
        const report = { ...execution.report, evidenceHandles: [handle.handleId] }
        params.context.workerReports.push(report)
        packageState.evidenceHandleIds = [handle.handleId]
        params.context.evidenceResources.push({
          refId: handle.handleId,
          digest: handle.digest,
          provenance: `${handle.kind}:${handle.childTaskId}`,
          excerpt: excerpt.slice(0, 1600),
          kind: 'artifact',
        })
        params.context.usage.add(execution.usage)
      }
    }
    const nextState: DeliveryStateV1 = {
      ...params.context.state,
      stateRevision: params.context.state.stateRevision + 1,
      usage: params.context.usage.snapshot() ?? params.context.state.usage,
    }
    this.persistNextState(params.context, nextState)
    if (params.input.signal.aborted) {
      throw params.input.signal.reason ?? new DOMException('aborted', 'AbortError')
    }
  }

  recordOwnerUsage(runId: string, usage: ReadyAgentSdkRunResult['usage']): RunUsage | null {
    return this.contexts.addUsage(runId, usage)
  }

  private async verifySealedCandidate(input: Parameters<typeof verifyDeliveryCandidate>[0]): Promise<{
    verdict: DeliveryVerificationVerdict
    usage: ReadyAgentSdkRunResult['usage']
  }> {
    const issues = input.candidate.resources.mechanicalIssues ?? []
    if (issues.length > 0) {
      return {
        verdict: {
          version: 1,
          verdict: 'block',
          gaps: issues.map((issue) => ({
            kind: 'artifact' as const,
            description: `[${issue.code}] ${issue.description}`,
            ...(issue.targetRefId ? { targetRefId: issue.targetRefId } : {}),
          })),
          summary: '产物机械验收未通过，未进入语义复核。',
        },
        usage: undefined,
      }
    }
    return verifyDeliveryCandidate(input)
  }

  async buildSanitizedCheckpoint(runId: string, receipts: readonly AgentInputItem[] = []): Promise<AgentInputItem[] | null> {
    const context = this.contexts.get(runId)
    if (!context?.transaction) return null
    context.canonicalReceiptItems = await context.transaction.collectCanonicalReceiptItems()
    return context.transaction.buildSanitizedCheckpoint([...context.canonicalReceiptItems, ...receipts])
  }

  async verifyOwnerCandidate(input: {
    runId: string
    candidateText: string
    projectionAfterOwner: TaskProjectionRecord
    model: string
    provider: ModelProvider
    contextWindowTokens: number
    maxOutputTokens: number
    signal: AbortSignal
    artifactRepairTools?: AgentSdkTool[]
    materializeAndReadBack: () => Promise<VerifierResourceBundle>
  }): Promise<{
    verdict: DeliveryVerificationVerdict
    sealed: SealedDeliveryCandidate
    acceptedText: string | null
    usage: RunUsage | null
    verificationUsage: RunUsage | null
  }> {
    const context = this.contexts.get(input.runId)
    if (!context || !context.transaction || !context.outputBuffer) {
      throw new Error('[dynamic-delivery] candidate context is unavailable')
    }
    context.canonicalReceiptItems = await context.transaction.collectCanonicalReceiptItems()
    let candidateText = input.candidateText
    const materializeAndReadBack = async (): Promise<VerifierResourceBundle> => {
      const materialized = await input.materializeAndReadBack()
      return { ...materialized, items: [...materialized.items, ...context.evidenceResources] }
    }
    let sealed = await sealDeliveryCandidate({
      userRequestVerbatim: context.userRequestVerbatim,
      candidateText,
      hostCriteria: input.projectionAfterOwner.criteria ? [input.projectionAfterOwner.criteria] : [],
      modelCriteria: input.projectionAfterOwner.modelCriteria ?? [],
      openQuestions: context.workerReports.flatMap((report) => report.openQuestions),
      materializeAndReadBack,
    })
    let verification = await this.verifySealedCandidate({
      candidate: sealed,
      runId: input.runId,
      taskId: context.taskId,
      model: input.model,
      provider: input.provider,
      contextWindowTokens: input.contextWindowTokens,
      maxOutputTokens: input.maxOutputTokens,
      signal: input.signal,
      runAgent: this.runAgent,
    })
    if (verification.usage) context.usage.add(verification.usage)
    let supplementalUsage = verification.usage ? addRunUsage(null, verification.usage) : null
    let repaired = false
    if (verification.verdict.verdict === 'repair') {
      const repairKind = classifyDeliveryRepair(
        verification.verdict,
        new Set(input.projectionAfterOwner.contextRefs ?? []),
      )
      if (repairKind === 'text_only') {
        const repair = await this.runAgent({
          agentName: 'dynamic-delivery-owner-repair',
          runId: `${input.runId}:repair`,
          taskId: context.taskId,
          sessionId: `${input.runId}:candidate`,
          input: JSON.stringify({
            contract: 'dynamic_delivery_text_repair_v1',
            candidateText,
            gaps: verification.verdict.gaps,
          }),
          instructions: [
            context.ownerSystemPrompt,
            'Repair only the listed text gaps. Use no tools and return only the complete replacement answer.',
          ].filter(Boolean).join('\n\n'),
          model: input.model,
          provider: input.provider,
          session: context.ownerSession,
          tools: [],
          signal: input.signal,
          maxTurns: 1,
          contextWindowTokens: input.contextWindowTokens,
          maxOutputTokens: input.maxOutputTokens,
          onTextDelta: () => undefined,
        })
        context.usage.add(repair.usage)
        supplementalUsage = addRunUsage(supplementalUsage, repair.usage)
        candidateText = repair.finalText.trim()
        context.outputBuffer.replace(candidateText)
        sealed = await sealDeliveryCandidate({
          userRequestVerbatim: context.userRequestVerbatim,
          candidateText,
          hostCriteria: input.projectionAfterOwner.criteria ? [input.projectionAfterOwner.criteria] : [],
          modelCriteria: input.projectionAfterOwner.modelCriteria ?? [],
          openQuestions: context.workerReports.flatMap((report) => report.openQuestions),
          materializeAndReadBack,
        })
        verification = await this.verifySealedCandidate({
          candidate: sealed,
          runId: `${input.runId}:repair`,
          taskId: context.taskId,
          model: input.model,
          provider: input.provider,
          contextWindowTokens: input.contextWindowTokens,
          maxOutputTokens: input.maxOutputTokens,
          signal: input.signal,
          runAgent: this.runAgent,
        })
        if (verification.usage) {
          context.usage.add(verification.usage)
          supplementalUsage = addRunUsage(supplementalUsage, verification.usage)
        }
        repaired = true
      } else if (repairKind === 'artifact_targeted' && input.artifactRepairTools?.length) {
        const targetRefIds = [...new Set(verification.verdict.gaps
          .map((gap) => gap.targetRefId)
          .filter((value): value is string => Boolean(value)))]
        const repair = await this.runAgent({
          agentName: 'dynamic-delivery-owner-artifact-repair',
          runId: `${input.runId}:artifact-repair`,
          taskId: context.taskId,
          sessionId: `${input.runId}:candidate`,
          input: JSON.stringify({
            contract: 'dynamic_delivery_artifact_repair_v1',
            allowedTargetRefIds: targetRefIds,
            gaps: verification.verdict.gaps,
          }),
          instructions: [
            context.ownerSystemPrompt,
            'Repair only the listed gaps on the listed existing targets. Read back and save the same target. Do not perform external actions or touch any other target.',
          ].filter(Boolean).join('\n\n'),
          model: input.model,
          provider: input.provider,
          session: context.ownerSession,
          tools: input.artifactRepairTools,
          signal: input.signal,
          maxTurns: 2,
          contextWindowTokens: input.contextWindowTokens,
          maxOutputTokens: input.maxOutputTokens,
          onTextDelta: () => undefined,
        })
        context.usage.add(repair.usage)
        supplementalUsage = addRunUsage(supplementalUsage, repair.usage)
        candidateText = repair.finalText.trim() || candidateText
        context.outputBuffer.replace(candidateText)
        sealed = await sealDeliveryCandidate({
          userRequestVerbatim: context.userRequestVerbatim,
          candidateText,
          hostCriteria: input.projectionAfterOwner.criteria ? [input.projectionAfterOwner.criteria] : [],
          modelCriteria: input.projectionAfterOwner.modelCriteria ?? [],
          openQuestions: context.workerReports.flatMap((report) => report.openQuestions),
          materializeAndReadBack,
        })
        verification = await this.verifySealedCandidate({
          candidate: sealed,
          runId: `${input.runId}:artifact-repair`,
          taskId: context.taskId,
          model: input.model,
          provider: input.provider,
          contextWindowTokens: input.contextWindowTokens,
          maxOutputTokens: input.maxOutputTokens,
          signal: input.signal,
          runAgent: this.runAgent,
        })
        if (verification.usage) {
          context.usage.add(verification.usage)
          supplementalUsage = addRunUsage(supplementalUsage, verification.usage)
        }
        repaired = true
      }
    }
    const blockedRequiredPackages = context.state.packages.filter(
      (entry) => entry.criticality === 'required' && entry.status === 'blocked',
    )
    if (verification.verdict.verdict === 'accept' && blockedRequiredPackages.length > 0) {
      verification = {
        ...verification,
        verdict: {
          version: 1,
          verdict: 'block',
          gaps: blockedRequiredPackages.map((entry) => ({
            kind: 'text' as const,
            description: `Required work package did not complete: ${entry.packageId}`,
          })),
          summary: 'Required work packages must complete before delivery can be accepted.',
        },
      }
    }
    if (verification.verdict.verdict === 'accept') {
      const verifierResourceIds = new Set(sealed.resources.items.map((item) => item.refId))
      const adoptedPackages = context.state.packages.map((entry) => {
        const report = context.workerReports.find((item) => item.packageId === entry.packageId)
        const evidenceHandleIds = report?.evidenceHandles ?? entry.evidenceHandleIds
        const withEvidence = { ...entry, evidenceHandleIds: [...evidenceHandleIds] }
        return {
          ...withEvidence,
          adoptedByOwner: isRegisteredContributionAdoptable(withEvidence, verifierResourceIds),
        }
      })
      const acceptedText = context.outputBuffer.snapshot()
      const acceptedInputItems = await context.transaction.collectAcceptedInputItems()
      await context.transaction.commitAccepted([
        ...acceptedInputItems,
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: acceptedText }],
        } as AgentInputItem,
      ])
      const nextState: DeliveryStateV1 = {
        ...context.state,
        stateRevision: context.state.stateRevision + 1,
        packages: adoptedPackages,
        verifier: { status: 'accepted', repaired },
        usage: context.usage.snapshot() ?? context.state.usage,
      }
      this.persistNextState(context, nextState)
      logAgentMetric('dynamic_delivery_finished', {
        runId: input.runId,
        taskId: context.taskId,
        verdict: 'accepted',
        repaired,
      })
      return {
        verdict: verification.verdict,
        sealed,
        acceptedText: context.outputBuffer.releaseAccepted(),
        usage: context.usage.snapshot(),
        verificationUsage: supplementalUsage,
      }
    }
    context.transaction.abortCandidate()
    context.outputBuffer.discard()
    const nextState: DeliveryStateV1 = {
      ...context.state,
      stateRevision: context.state.stateRevision + 1,
      verifier: { status: 'blocked', repaired: false },
      usage: context.usage.snapshot() ?? context.state.usage,
    }
    this.persistNextState(context, nextState)
    logAgentMetric('dynamic_delivery_finished', {
      runId: input.runId,
      taskId: context.taskId,
      verdict: 'blocked',
      repaired,
    })
    return {
      verdict: verification.verdict,
      sealed,
      acceptedText: null,
      usage: context.usage.snapshot(),
      verificationUsage: supplementalUsage,
    }
  }

  close(runId: string): void {
    this.contexts.close(runId)
  }
}
