import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  codexCurrentDocumentAnchorSchema,
  type CodexCurrentDocumentAnchor,
} from '../../../../shared/ipc-contracts/agent-runtime'
import {
  parseActionAuthorizationMode,
  type ActionAuthorizationMode,
} from '../../../../shared/action-authorization-mode'

import {
  codexUserInputSchema,
  digestCodexUserInput,
  type CodexUserInput,
} from './codex-user-input'
import type {
  CodexTurnIngress,
  ExplicitResourceEnvelope,
  ResourceVersionReference,
  UserIngress,
} from './codex-turn-input-builder'
import { resourceReferenceSetsMatch } from './codex-turn-input-builder'
import { resolveExplicitRetryTailPlan } from './codex-history-continuity-policy'
import { digestCanonicalJson } from './codex-model-gateway-contract'
import {
  assertReadyToolSurface,
  assertReadyTurnToolAuthorization,
  type ReadyToolSurface,
  type ReadyTurnToolAuthorization,
} from './codex-tool-surface'
import {
  assertPreparedCodexExternalReadSlice,
  externalReadResourceAuthority,
  type PreparedCodexExternalReadSlice,
} from './codex-external-read-slice'
import {
  preparedCodexResourceAuthoritySchema,
  type PreparedCodexResourceAuthority,
} from './codex-explicit-resources'
import type { TrustedRequestEnvironment } from '../contracts/request-envelope'
import {
  assertReadyMemorySnapshot,
  type ReadyMemorySnapshot,
} from '../ready-memory'
import {
  emptyReadyActionObligationSet,
  isReadyActionObligationSet,
  readyActionObligationSetSchema,
  type ReadyActionObligationSetV1,
} from './codex-action-obligation'

export type ReadyToolSurfaceRef = ReadyToolSurface

export type ReadyTurnToolAuthorizationRef = ReadyTurnToolAuthorization

export type CodexOutputContract = Readonly<{
  contract: 'codex_output_contract_v1'
  destination: Readonly<{
    logicalResourceId: string
    path: string
    currentVersion: string
    currentDigest: string
    policyEpoch: number
    directoryIdentity: Readonly<{
      device: string
      inode: string
      mode: number
      mtimeMs: number
    }>
  }>
  activation: 'pending_confirmation'
  activationPredicateDigest: string
  maxExpectedOutputs: 8
  targetPolicy: 'create_only'
}>

export type CodexProductBudgetSeed = Readonly<{
  maxIterations: number
  maxToolCalls: number
  maxParallelToolGroups: number
  lanes: Readonly<{
    ordinary: Readonly<{ maxIterations: number; maxToolCalls: number; maxParallelToolGroups: number }>
    delivery: Readonly<{ maxIterations: number; maxToolCalls: number; maxParallelToolGroups: number }>
    final: Readonly<{ maxIterations: 1 }>
  }>
}>

export type CodexRetryArtifactSource = Readonly<{
  sourceReadyRunId: string
  relativePath: string
  logicalArtifactRef: string
  version: string
  sha256: string
  state: 'staged' | 'exported' | 'verified' | 'indeterminate'
}>

export type ReadyToolHostIdentity = {
  scopeId: string
  aliasId: string
  authorizationOwnerId: string
  resourceOwnerId: string
}

export type PreparedCodexProductRun = {
  preparationContract: 'codex_product_run_e2'
  taskId: string
  runId: string
  conversationAlias: {
    aliasId: string
    aliasGeneration: number
  }
  ingressBinding: {
    requestId: string
    reservationSetId: string
    reservationEvidenceDigest: string
  }
  ingress: Extract<CodexTurnIngress, { kind: 'user_ingress' }>
  resourceAnchorDigest: string
  sourceTrustedEnvironmentRef: {
    workbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
    environmentDigest: string
  }
  actionAuthorizationMode?: ActionAuthorizationMode
  readyMemorySnapshot: ReadyMemorySnapshot
  readyToolSurface: ReadyToolSurfaceRef
  readyTurnToolAuthorization: ReadyTurnToolAuthorizationRef
  readyToolHostIdentity: ReadyToolHostIdentity
  externalReadSlice?: PreparedCodexExternalReadSlice
  resourceAuthorities?: PreparedCodexResourceAuthority[]
  outputContract?: CodexOutputContract
  browserPageRef?: NonNullable<TrustedRequestEnvironment['browserPageRef']>
  productSurfaceTargets?: {
    rssItemId?: string | null
    rssSourceId?: string | null
    calendarEventId?: string | null
    calendarWindow?: { start: string; end: string; calendarId?: string } | null
    widgetId?: string | null
  }
  actionObligations?: ReadyActionObligationSetV1
  mcpCatalog?: { generation: number; digest: string }
  productBudgetSeed: CodexProductBudgetSeed
  neutralProjectionSeed: {
    phase: 'planning'
    taskTitle: '正在理解需求'
    taskSummary: '正在整理任务边界、资源与可用能力'
  }
}

export type CodexProductRunPreparationInput = {
  taskId: string
  runId: string
  requestId: string
  scopeId: string
  aliasId: string
  aliasGeneration: number
  taskOrigin: 'user_root' | 'workflow_child'
  runOrigin: 'initial' | 'continuation' | 'scheduled_task' | 'handoff_takeover'
  originUserMessageId?: string
  reservationSetId: string
  reservationEvidenceDigest: string
  currentInput: CodexUserInput[]
  explicitResourceEnvelope: ExplicitResourceEnvelope
  resourceAdditionalContext: ResourceVersionReference[]
  trustedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
  currentDocumentAnchor?: CodexCurrentDocumentAnchor | null
  uncommittedUserTail?: UserIngress['uncommittedUserTail']
  actionAdmissionRef?: UserIngress['actionAdmissionRef']
  uncommittedTailAssignments: NonNullable<UserIngress['uncommittedTailAssignments']>
  supersededUncommittedItems: NonNullable<UserIngress['supersededUncommittedItems']>
  actionAuthorizationMode?: ActionAuthorizationMode
  readyMemorySnapshot: ReadyMemorySnapshot
  readyToolSurface: ReadyToolSurfaceRef
  readyTurnToolAuthorization: ReadyTurnToolAuthorizationRef
  authorizationOwnerId: string
  resourceOwnerId: string
  externalReadSlice?: PreparedCodexExternalReadSlice | null
  resourceAuthorities?: PreparedCodexResourceAuthority[]
  browserPageRef?: NonNullable<TrustedRequestEnvironment['browserPageRef']>
  productSurfaceTargets?: PreparedCodexProductRun['productSurfaceTargets']
  actionObligations?: ReadyActionObligationSetV1
  mcpCatalog?: { generation: number; digest: string }
  productBudgetSeed: {
    maxIterations: number
    maxToolCalls: number
    maxParallelToolGroups: number
  }
  explicitRetry?: {
    predecessorRunId: string
    predecessorPresentationRef: NonNullable<UserIngress['predecessorPresentationRef']>
    controlAuditMessageRef: NonNullable<UserIngress['controlAuditMessageRef']>
    modelVisibleRootOriginRef: NonNullable<UserIngress['modelVisibleRootOriginRef']>
    selectedHistorySeedItemRef: NonNullable<UserIngress['selectedHistorySeedItemRef']>
    currentTrustedEnvironmentRef: NonNullable<UserIngress['currentTrustedEnvironmentRef']>
    sourceTrustedEnvironmentRef: PreparedCodexProductRun['sourceTrustedEnvironmentRef']
    historyParityEvidenceDigest: string
    currentThreadReadEvidenceDigest: string
    continuationContractDigest: string
    taskRootInput: CodexUserInput[]
    taskRootInputDigest: string
    artifactSources: CodexRetryArtifactSource[]
  }
}

export type CodexProductRunPreparationResult =
  | { ok: true; prepared: PreparedCodexProductRun }
  | { ok: false; code: 'unsupported_product_ingress' | 'invalid_product_ingress' }

const nonEmptyString = z.string().min(1)
const resourceRefSchema = z.object({
  logicalResourceId: nonEmptyString,
  currentVersion: nonEmptyString,
  currentDigest: nonEmptyString,
  supersedesVersion: nonEmptyString.nullable(),
  policyEpoch: z.number().int().positive(),
}).strict()
const budgetSeedSchema = z.object({
  maxIterations: z.number().int().positive(),
  maxToolCalls: z.number().int().nonnegative(),
  maxParallelToolGroups: z.number().int().nonnegative(),
}).strict()
const productBudgetSeedSchema = budgetSeedSchema.extend({
  lanes: z.object({
    ordinary: budgetSeedSchema,
    delivery: z.object({
      maxIterations: z.number().int().nonnegative(),
      maxToolCalls: z.number().int().nonnegative(),
      maxParallelToolGroups: z.number().int().nonnegative(),
    }).strict(),
    final: z.object({ maxIterations: z.literal(1) }).strict(),
  }).strict(),
}).strict()
const outputContractSchema = z.object({
  contract: z.literal('codex_output_contract_v1'),
  destination: z.object({
    logicalResourceId: nonEmptyString,
    path: nonEmptyString,
    currentVersion: nonEmptyString,
    currentDigest: nonEmptyString,
    policyEpoch: z.number().int().positive(),
    directoryIdentity: z.object({
      device: nonEmptyString,
      inode: nonEmptyString,
      mode: z.number().int().nonnegative(),
      mtimeMs: z.number().nonnegative(),
    }).strict(),
  }).strict(),
  activation: z.literal('pending_confirmation'),
  activationPredicateDigest: nonEmptyString,
  maxExpectedOutputs: z.literal(8),
  targetPolicy: z.literal('create_only'),
}).strict()
const retryArtifactSourceSchema = z.object({
  sourceReadyRunId: nonEmptyString,
  relativePath: nonEmptyString,
  logicalArtifactRef: nonEmptyString,
  version: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['staged', 'exported', 'verified', 'indeterminate']),
}).strict()
const readyToolSurfaceSchema = z.custom<ReadyToolSurface>((value) => {
  try {
    assertReadyToolSurface(value as ReadyToolSurface)
    return true
  } catch {
    return false
  }
})
const readyTurnToolAuthorizationSchema = z.custom<ReadyTurnToolAuthorization>((value) => {
  try {
    assertReadyTurnToolAuthorization(value as ReadyTurnToolAuthorization)
    return true
  } catch {
    return false
  }
})
const readyMemorySnapshotSchema = z.custom<ReadyMemorySnapshot>((value) => {
  try {
    assertReadyMemorySnapshot(value)
    return true
  } catch {
    return false
  }
})
const preparedExternalReadSliceSchema = z.custom<PreparedCodexExternalReadSlice>((value) => {
  try {
    assertPreparedCodexExternalReadSlice(value)
    return true
  } catch {
    return false
  }
})
const browserPageRefSchema = z.object({
  tabId: nonEmptyString,
  physicalTargetToken: nonEmptyString,
  mainFrameId: nonEmptyString,
  mainFrameDocumentToken: nonEmptyString,
  profileId: z.string().nullable().optional(),
}).strict()
const userIngressPreparationSchema = z.object({
  kind: z.literal('user_ingress'),
  attemptKind: z.enum(['user_ingress', 'explicit_retry']),
  originUserMessageId: nonEmptyString,
  canonicalCurrentInputRef: z.object({
    messageId: nonEmptyString,
    input: z.array(codexUserInputSchema).min(1),
  }).strict(),
  explicitResourceEnvelope: z.object({
    input: z.array(codexUserInputSchema),
    resourceRefs: z.array(resourceRefSchema),
  }).strict(),
  resourceAdditionalContext: z.array(resourceRefSchema),
  currentDocumentAnchor: codexCurrentDocumentAnchorSchema.nullable().optional(),
  uncommittedUserTail: z.array(z.object({
    originUserMessageId: nonEmptyString,
    input: z.array(codexUserInputSchema).min(1),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    policy: z.enum([
      'untrusted_text_history',
      'resource_restatement_required',
      'task_restatement_required',
    ]),
  }).strict()).min(1).max(8).optional(),
  actionAdmissionRef: z.object({
    headProjectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    actionProjectionVersion: z.object({
      scopeEpoch: z.number().int().nonnegative().safe(),
      headGeneration: z.number().int().positive().safe(),
      actionProjectionSequence: z.number().int().nonnegative().safe(),
    }).strict(),
    actionHeadIdentity: z.object({
      aliasId: nonEmptyString,
      aliasGeneration: z.number().int().positive().safe(),
      threadBindingId: nonEmptyString,
      headRevision: z.number().int().positive().safe(),
    }).strict(),
  }).strict().optional(),
  uncommittedTailAssignments: z.array(z.object({
    originUserMessageId: nonEmptyString,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    plan: z.enum([
      'deliver_untrusted_history',
      'replace_with_explicit_retry',
      'omit_from_current_run',
    ]),
  }).strict()).max(8),
  supersededUncommittedItems: z.array(z.object({
    originUserMessageId: nonEmptyString,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    policy: z.enum(['resource_restatement_required', 'task_restatement_required']),
  }).strict()).max(8),
  predecessorRunId: nonEmptyString.optional(),
  predecessorPresentationRef: z.object({
    readyRunId: nonEmptyString,
    presentationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  controlAuditMessageRef: z.object({
    messageId: nonEmptyString,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  modelVisibleRootOriginRef: z.object({
    sourceReadyRunId: nonEmptyString,
    sourceIngressContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
    originUserMessageId: nonEmptyString,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  selectedHistorySeedItemRef: z.object({
    threadBindingId: nonEmptyString,
    historySeedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    originUserMessageId: nonEmptyString,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  currentTrustedEnvironmentRef: z.object({
    requestedWorkbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']),
    trustedWorkbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']),
    modeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  historyParityEvidenceDigest: nonEmptyString.optional(),
  currentThreadReadEvidenceDigest: nonEmptyString.optional(),
  continuationContractDigest: nonEmptyString.optional(),
  taskRootInput: z.array(codexUserInputSchema).min(1).optional(),
  taskRootInputDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  artifactSources: z.array(retryArtifactSourceSchema).max(8).optional(),
}).strict()
const preparationInputSchema = z.object({
  taskId: nonEmptyString,
  runId: nonEmptyString,
  requestId: nonEmptyString,
  scopeId: nonEmptyString,
  aliasId: nonEmptyString,
  aliasGeneration: z.number().int().positive(),
  taskOrigin: z.enum(['user_root', 'workflow_child']),
  runOrigin: z.enum(['initial', 'continuation', 'scheduled_task', 'handoff_takeover']),
  originUserMessageId: nonEmptyString.optional(),
  reservationSetId: nonEmptyString,
  reservationEvidenceDigest: nonEmptyString,
  currentInput: z.array(codexUserInputSchema).min(1),
  explicitResourceEnvelope: z.object({
    input: z.array(codexUserInputSchema),
    resourceRefs: z.array(resourceRefSchema),
  }).strict(),
  resourceAdditionalContext: z.array(resourceRefSchema),
  trustedWorkbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']),
  currentDocumentAnchor: codexCurrentDocumentAnchorSchema.nullable().optional(),
  uncommittedUserTail: userIngressPreparationSchema.shape.uncommittedUserTail,
  actionAdmissionRef: userIngressPreparationSchema.shape.actionAdmissionRef,
  uncommittedTailAssignments: userIngressPreparationSchema.shape.uncommittedTailAssignments,
  supersededUncommittedItems: userIngressPreparationSchema.shape.supersededUncommittedItems,
  actionAuthorizationMode: z.enum(['ask', 'auto', 'full']).optional(),
  readyMemorySnapshot: readyMemorySnapshotSchema,
  readyToolSurface: readyToolSurfaceSchema,
  readyTurnToolAuthorization: readyTurnToolAuthorizationSchema,
  authorizationOwnerId: nonEmptyString,
  resourceOwnerId: nonEmptyString,
  externalReadSlice: preparedExternalReadSliceSchema.nullable().optional(),
  resourceAuthorities: z.array(preparedCodexResourceAuthoritySchema).optional(),
  browserPageRef: browserPageRefSchema.optional(),
  productSurfaceTargets: z.object({
    rssItemId: z.string().nullable().optional(),
    rssSourceId: z.string().nullable().optional(),
    calendarEventId: z.string().nullable().optional(),
    calendarWindow: z.object({
      start: z.string(),
      end: z.string(),
      calendarId: z.string().optional(),
    }).strict().nullable().optional(),
    widgetId: z.string().nullable().optional(),
  }).strict().optional(),
  actionObligations: readyActionObligationSetSchema.optional(),
  mcpCatalog: z.object({
    generation: z.number().int().nonnegative(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  productBudgetSeed: budgetSeedSchema,
  explicitRetry: z.object({
    predecessorRunId: nonEmptyString,
    predecessorPresentationRef: userIngressPreparationSchema.shape.predecessorPresentationRef.unwrap(),
    controlAuditMessageRef: userIngressPreparationSchema.shape.controlAuditMessageRef.unwrap(),
    modelVisibleRootOriginRef: userIngressPreparationSchema.shape.modelVisibleRootOriginRef.unwrap(),
    selectedHistorySeedItemRef: userIngressPreparationSchema.shape.selectedHistorySeedItemRef.unwrap(),
    currentTrustedEnvironmentRef: userIngressPreparationSchema.shape.currentTrustedEnvironmentRef.unwrap(),
    sourceTrustedEnvironmentRef: z.object({
      workbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']),
      environmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
    historyParityEvidenceDigest: nonEmptyString,
    currentThreadReadEvidenceDigest: nonEmptyString,
    continuationContractDigest: nonEmptyString,
    taskRootInput: z.array(codexUserInputSchema).min(1),
    taskRootInputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    artifactSources: z.tuple([]),
  }).strict().optional(),
}).strict()
const preparedRunSchema = z.object({
  preparationContract: z.literal('codex_product_run_e2'),
  taskId: nonEmptyString,
  runId: nonEmptyString,
  conversationAlias: z.object({
    aliasId: nonEmptyString,
    aliasGeneration: z.number().int().positive(),
  }).strict(),
  ingressBinding: z.object({
    requestId: nonEmptyString,
    reservationSetId: nonEmptyString,
    reservationEvidenceDigest: nonEmptyString,
  }).strict(),
  ingress: userIngressPreparationSchema,
  resourceAnchorDigest: nonEmptyString,
  sourceTrustedEnvironmentRef: z.object({
    workbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']),
    environmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  actionAuthorizationMode: z.enum(['ask', 'auto', 'full']).optional(),
  readyMemorySnapshot: readyMemorySnapshotSchema,
  readyToolSurface: readyToolSurfaceSchema,
  readyTurnToolAuthorization: readyTurnToolAuthorizationSchema,
  readyToolHostIdentity: z.object({
    scopeId: nonEmptyString,
    aliasId: nonEmptyString,
    authorizationOwnerId: nonEmptyString,
    resourceOwnerId: nonEmptyString,
  }).strict(),
  externalReadSlice: preparedExternalReadSliceSchema.optional(),
  resourceAuthorities: z.array(preparedCodexResourceAuthoritySchema).optional(),
  outputContract: outputContractSchema.optional(),
  browserPageRef: browserPageRefSchema.optional(),
  productSurfaceTargets: z.object({
    rssItemId: z.string().nullable().optional(),
    rssSourceId: z.string().nullable().optional(),
    calendarEventId: z.string().nullable().optional(),
    calendarWindow: z.object({
      start: z.string(),
      end: z.string(),
      calendarId: z.string().optional(),
    }).strict().nullable().optional(),
    widgetId: z.string().nullable().optional(),
  }).strict().optional(),
  actionObligations: readyActionObligationSetSchema.optional(),
  mcpCatalog: z.object({
    generation: z.number().int().nonnegative(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  productBudgetSeed: productBudgetSeedSchema,
  neutralProjectionSeed: z.object({
    phase: z.literal('planning'),
    taskTitle: z.literal('正在理解需求'),
    taskSummary: z.literal('正在整理任务边界、资源与可用能力'),
  }).strict(),
}).strict()

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function validUncommittedTailContract(ingress: UserIngress): boolean {
  const tail = ingress.uncommittedUserTail || []
  const assignments = ingress.uncommittedTailAssignments || []
  if (tail.length !== assignments.length
    || new Set(tail.map((item) => item.originUserMessageId)).size !== tail.length
    || new Set(assignments.map((item) => item.originUserMessageId)).size !== assignments.length
    || tail.some((item) => digestCodexUserInput(item.input) !== item.inputDigest)
    || tail.some((item) => !assignments.some((assignment) => (
      assignment.originUserMessageId === item.originUserMessageId
      && assignment.inputDigest === item.inputDigest
    )))) return false
  if (ingress.attemptKind === 'explicit_retry') {
    const plan = resolveExplicitRetryTailPlan(tail, ingress.selectedHistorySeedItemRef)
    return ingress.actionAdmissionRef === undefined
      && plan.kind === 'eligible'
      && digestCanonicalJson(assignments) === digestCanonicalJson(plan.assignments)
      && (ingress.supersededUncommittedItems || []).length === 0
  }
  const superseded = ingress.supersededUncommittedItems || []
  const expectedSuperseded = tail.filter((item) => item.policy !== 'untrusted_text_history')
  return Boolean(ingress.actionAdmissionRef)
    && tail.every((item) => assignments.find(
      (assignment) => assignment.originUserMessageId === item.originUserMessageId,
    )?.plan === (item.policy === 'untrusted_text_history'
      ? 'deliver_untrusted_history'
      : 'omit_from_current_run'))
    && superseded.length === expectedSuperseded.length
    && expectedSuperseded.every((item) => superseded.some((candidate) => (
      candidate.originUserMessageId === item.originUserMessageId
      && candidate.inputDigest === item.inputDigest
      && candidate.policy === item.policy
    )))
}

function createOutputContract(
  authorities: readonly PreparedCodexResourceAuthority[],
): CodexOutputContract | null {
  const directories = authorities.filter((authority) => authority.kind === 'local_directory')
  if (directories.length !== 1) return null
  const destination = directories[0]
  if (!destination.directoryIdentity) return null
  const frozenDestination = {
    logicalResourceId: destination.logicalResourceId,
    path: destination.path,
    currentVersion: destination.currentVersion,
    currentDigest: destination.currentDigest,
    policyEpoch: destination.policyEpoch,
    directoryIdentity: { ...destination.directoryIdentity },
  }
  return Object.freeze({
    contract: 'codex_output_contract_v1',
    destination: Object.freeze({
      ...frozenDestination,
      directoryIdentity: Object.freeze(frozenDestination.directoryIdentity),
    }),
    activation: 'pending_confirmation',
    activationPredicateDigest: digest({
      contract: 'codex_folder_output_activation_v1',
      destination: frozenDestination,
      declarationTool: 'declare_completion_criteria',
      requiredPriorResultDelivery: true,
    }),
    maxExpectedOutputs: 8,
    targetPolicy: 'create_only',
  })
}

function createProductBudgetSeed(
  ordinary: CodexProductRunPreparationInput['productBudgetSeed'],
  hasOutputContract: boolean,
): CodexProductBudgetSeed {
  const delivery = hasOutputContract
    ? { maxIterations: 18, maxToolCalls: 25, maxParallelToolGroups: 0 }
    : { maxIterations: 0, maxToolCalls: 0, maxParallelToolGroups: 0 }
  return Object.freeze({
    maxIterations: ordinary.maxIterations + delivery.maxIterations + 1,
    maxToolCalls: ordinary.maxToolCalls + delivery.maxToolCalls,
    maxParallelToolGroups: ordinary.maxParallelToolGroups,
    lanes: Object.freeze({
      ordinary: Object.freeze({ ...ordinary }),
      delivery: Object.freeze(delivery),
      final: Object.freeze({ maxIterations: 1 as const }),
    }),
  })
}

export function isPreparedCodexProductRun(value: unknown): value is PreparedCodexProductRun {
  const parsed = preparedRunSchema.safeParse(value)
  if (!parsed.success) return false
  const prepared = parsed.data
  const directoryAuthorities = (prepared.resourceAuthorities ?? [])
    .filter((authority) => authority.kind === 'local_directory')
  const expectedOutputContract = createOutputContract(prepared.resourceAuthorities ?? [])
  return prepared.conversationAlias.aliasId === prepared.readyToolHostIdentity.aliasId
    && prepared.readyTurnToolAuthorization.allowedToolNames.every(
      (toolName) => prepared.readyToolSurface.toolNames.includes(toolName),
    )
    && (prepared.ingress.attemptKind === 'user_ingress'
      ? prepared.ingress.originUserMessageId === prepared.ingress.canonicalCurrentInputRef.messageId
      : prepared.ingress.originUserMessageId !== prepared.ingress.canonicalCurrentInputRef.messageId)
    && validUncommittedTailContract(prepared.ingress)
    && (prepared.ingress.attemptKind === 'explicit_retry'
      ? Boolean(
          prepared.ingress.predecessorRunId
          && prepared.ingress.predecessorPresentationRef
          && prepared.ingress.predecessorPresentationRef.readyRunId
            === prepared.ingress.predecessorRunId
          && prepared.ingress.controlAuditMessageRef
          && prepared.ingress.controlAuditMessageRef.messageId
            === prepared.ingress.originUserMessageId
          && prepared.ingress.modelVisibleRootOriginRef
          && prepared.ingress.selectedHistorySeedItemRef
          && prepared.ingress.currentTrustedEnvironmentRef
          && prepared.ingress.currentTrustedEnvironmentRef.requestedWorkbenchMode
            === prepared.ingress.currentTrustedEnvironmentRef.trustedWorkbenchMode
          && prepared.ingress.currentTrustedEnvironmentRef.modeDigest === digest({
            requestedWorkbenchMode:
              prepared.ingress.currentTrustedEnvironmentRef.requestedWorkbenchMode,
            trustedWorkbenchMode:
              prepared.ingress.currentTrustedEnvironmentRef.trustedWorkbenchMode,
          })
          && prepared.sourceTrustedEnvironmentRef.workbenchMode
            === prepared.ingress.currentTrustedEnvironmentRef.trustedWorkbenchMode
          && prepared.ingress.canonicalCurrentInputRef.messageId
            === prepared.ingress.modelVisibleRootOriginRef.originUserMessageId
          && digestCodexUserInput(prepared.ingress.canonicalCurrentInputRef.input)
            === prepared.ingress.modelVisibleRootOriginRef.inputDigest
          && prepared.ingress.selectedHistorySeedItemRef.originUserMessageId
            === prepared.ingress.modelVisibleRootOriginRef.originUserMessageId
          && prepared.ingress.selectedHistorySeedItemRef.inputDigest
            === prepared.ingress.modelVisibleRootOriginRef.inputDigest
          && prepared.ingress.historyParityEvidenceDigest
          && prepared.ingress.currentThreadReadEvidenceDigest
          && prepared.ingress.continuationContractDigest
          && prepared.ingress.taskRootInput
          && prepared.ingress.taskRootInputDigest
          && digestCodexUserInput(prepared.ingress.taskRootInput)
            === prepared.ingress.taskRootInputDigest
          && prepared.ingress.artifactSources?.length === 0,
        )
      : prepared.ingress.predecessorRunId === undefined
        && prepared.ingress.historyParityEvidenceDigest === undefined
        && prepared.ingress.currentThreadReadEvidenceDigest === undefined
        && prepared.ingress.continuationContractDigest === undefined
        && prepared.ingress.predecessorPresentationRef === undefined
        && prepared.ingress.controlAuditMessageRef === undefined
        && prepared.ingress.modelVisibleRootOriginRef === undefined
        && prepared.ingress.selectedHistorySeedItemRef === undefined
        && prepared.ingress.currentTrustedEnvironmentRef === undefined
        && prepared.ingress.artifactSources === undefined)
    && resourceReferenceSetsMatch(
      prepared.ingress.explicitResourceEnvelope.resourceRefs,
      prepared.ingress.resourceAdditionalContext,
    )
    && prepared.resourceAnchorDigest === digest({
          explicitResourceEnvelope: prepared.ingress.explicitResourceEnvelope,
          resourceAdditionalContext: prepared.ingress.resourceAdditionalContext,
          ...(prepared.ingress.currentDocumentAnchor
            ? { currentDocumentAnchor: prepared.ingress.currentDocumentAnchor }
            : {}),
          ...(prepared.externalReadSlice
            ? { externalReadResourceAuthority: externalReadResourceAuthority(prepared.externalReadSlice) }
            : {}),
          ...(prepared.resourceAuthorities?.length
            ? { resourceAuthorities: prepared.resourceAuthorities }
            : {}),
          ...(prepared.browserPageRef ? { browserPageRef: prepared.browserPageRef } : {}),
        })
    && directoryAuthorities.every((authority) => authority.directoryIdentity != null)
    && (prepared.actionObligations === undefined
      || (
        isReadyActionObligationSet(prepared.actionObligations)
        && prepared.actionObligations.requirements.every((requirement) => (
          requirement.allowedToolNames.every((toolName) => (
            prepared.readyTurnToolAuthorization.allowedToolNames.includes(toolName)
          ))
        ))
      ))
    && JSON.stringify(prepared.outputContract ?? null) === JSON.stringify(expectedOutputContract)
    && prepared.productBudgetSeed.maxIterations
      === prepared.productBudgetSeed.lanes.ordinary.maxIterations
        + prepared.productBudgetSeed.lanes.delivery.maxIterations
        + prepared.productBudgetSeed.lanes.final.maxIterations
    && prepared.productBudgetSeed.maxToolCalls
      === prepared.productBudgetSeed.lanes.ordinary.maxToolCalls
        + prepared.productBudgetSeed.lanes.delivery.maxToolCalls
}

export function preparedCodexProductRunMatchesIngress(
  value: unknown,
  expected: {
    scopeId: string
    aliasId: string
    aliasGeneration: number | null
    requestId: string
    originUserMessageId: string
    reservationSetId: string
    reservationEvidenceDigest: string
  },
): value is PreparedCodexProductRun {
  return isPreparedCodexProductRun(value)
    && value.readyToolHostIdentity.scopeId === expected.scopeId
    && value.conversationAlias.aliasId === expected.aliasId
    && value.conversationAlias.aliasGeneration === expected.aliasGeneration
    && value.ingressBinding.requestId === expected.requestId
    && value.ingressBinding.reservationSetId === expected.reservationSetId
    && value.ingressBinding.reservationEvidenceDigest === expected.reservationEvidenceDigest
    && value.ingress.kind === 'user_ingress'
    && value.ingress.originUserMessageId === expected.originUserMessageId
}

export class CodexProductRunPreparer {
  prepare(rawInput: unknown): CodexProductRunPreparationResult {
    const parsed = preparationInputSchema.safeParse(rawInput)
    if (!parsed.success) return { ok: false, code: 'invalid_product_ingress' }
    const input = parsed.data
    const isUserIngress = input.taskOrigin === 'user_root' && input.runOrigin === 'initial'
    if (!isUserIngress) {
      return { ok: false, code: 'unsupported_product_ingress' }
    }
    if (!input.originUserMessageId) {
      return { ok: false, code: 'invalid_product_ingress' }
    }
    if (input.explicitRetry && input.explicitRetry.predecessorRunId === input.runId) {
      return { ok: false, code: 'invalid_product_ingress' }
    }
    if (input.explicitRetry
      && digestCodexUserInput(input.explicitRetry.taskRootInput)
        !== input.explicitRetry.taskRootInputDigest) {
      return { ok: false, code: 'invalid_product_ingress' }
    }
    if (input.explicitRetry && (
      input.explicitRetry.predecessorPresentationRef.readyRunId
        !== input.explicitRetry.predecessorRunId
      || input.explicitRetry.controlAuditMessageRef.messageId !== input.originUserMessageId
      || input.explicitRetry.controlAuditMessageRef.inputDigest
        !== digestCodexUserInput(input.currentInput)
      || input.explicitRetry.modelVisibleRootOriginRef.inputDigest
        !== input.explicitRetry.taskRootInputDigest
      || input.explicitRetry.selectedHistorySeedItemRef.originUserMessageId
        !== input.explicitRetry.modelVisibleRootOriginRef.originUserMessageId
      || input.explicitRetry.selectedHistorySeedItemRef.inputDigest
        !== input.explicitRetry.modelVisibleRootOriginRef.inputDigest
      || input.explicitRetry.currentTrustedEnvironmentRef.requestedWorkbenchMode
        !== input.explicitRetry.currentTrustedEnvironmentRef.trustedWorkbenchMode
      || input.explicitRetry.currentTrustedEnvironmentRef.modeDigest !== digest({
        requestedWorkbenchMode:
          input.explicitRetry.currentTrustedEnvironmentRef.requestedWorkbenchMode,
        trustedWorkbenchMode:
          input.explicitRetry.currentTrustedEnvironmentRef.trustedWorkbenchMode,
      })
      || input.explicitRetry.sourceTrustedEnvironmentRef.workbenchMode
        !== input.explicitRetry.currentTrustedEnvironmentRef.trustedWorkbenchMode
      || input.explicitRetry.artifactSources.length !== 0
    )) return { ok: false, code: 'invalid_product_ingress' }
    const canonicalCurrentInputRef = input.explicitRetry ? {
      messageId: input.explicitRetry.modelVisibleRootOriginRef.originUserMessageId,
      input: input.explicitRetry.taskRootInput,
    } : {
      messageId: input.originUserMessageId,
      input: input.currentInput,
    }
    const explicitRetryIngress = input.explicitRetry ? (() => {
      const { sourceTrustedEnvironmentRef: _source, ...ingressFields } = input.explicitRetry
      return ingressFields
    })() : undefined
    const candidateIngress: UserIngress = {
      kind: 'user_ingress',
      attemptKind: input.explicitRetry ? 'explicit_retry' : 'user_ingress',
      originUserMessageId: input.originUserMessageId,
      canonicalCurrentInputRef,
      explicitResourceEnvelope: input.explicitResourceEnvelope,
      resourceAdditionalContext: input.resourceAdditionalContext,
      ...(input.currentDocumentAnchor ? { currentDocumentAnchor: input.currentDocumentAnchor } : {}),
      ...(input.uncommittedUserTail?.length
        ? { uncommittedUserTail: input.uncommittedUserTail }
        : {}),
      ...(input.actionAdmissionRef ? { actionAdmissionRef: input.actionAdmissionRef } : {}),
      uncommittedTailAssignments: input.uncommittedTailAssignments,
      supersededUncommittedItems: input.supersededUncommittedItems,
      ...(explicitRetryIngress || {}),
    }
    if (!validUncommittedTailContract(candidateIngress)) {
      return { ok: false, code: 'invalid_product_ingress' }
    }
    if (!resourceReferenceSetsMatch(
      input.explicitResourceEnvelope.resourceRefs,
      input.resourceAdditionalContext,
    )) {
      return { ok: false, code: 'invalid_product_ingress' }
    }
    if (input.readyTurnToolAuthorization.allowedToolNames.some(
      (toolName) => !input.readyToolSurface.toolNames.includes(toolName),
    )) {
      return { ok: false, code: 'invalid_product_ingress' }
    }
    const currentDocumentAnchor = input.currentDocumentAnchor ?? null
    const externalReadSlice = input.externalReadSlice ?? null
    const resourceAuthorities = input.resourceAuthorities ?? []
    const actionObligations = input.actionObligations ?? emptyReadyActionObligationSet()
    const outputContract = createOutputContract(resourceAuthorities)
    if (resourceAuthorities.some((authority) => (
      authority.kind === 'local_directory' && !authority.directoryIdentity
    ))) {
      return { ok: false, code: 'invalid_product_ingress' }
    }
    if (!isReadyActionObligationSet(actionObligations)
      || actionObligations.requirements.some((requirement) => (
        requirement.allowedToolNames.some((toolName) => (
          !input.readyTurnToolAuthorization.allowedToolNames.includes(toolName)
        ))
      ))) {
      return { ok: false, code: 'invalid_product_ingress' }
    }
    if (currentDocumentAnchor) {
      const matchingReference = input.resourceAdditionalContext.find(
        (reference) => reference.logicalResourceId === currentDocumentAnchor.logicalResourceId,
      )
      if (!matchingReference
        || matchingReference.currentVersion !== currentDocumentAnchor.currentVersion
        || matchingReference.currentDigest !== currentDocumentAnchor.currentDigest
        || matchingReference.supersedesVersion !== currentDocumentAnchor.supersedesVersion
        || matchingReference.policyEpoch !== currentDocumentAnchor.policyEpoch) {
        return { ok: false, code: 'invalid_product_ingress' }
      }
    }
    if (externalReadSlice) {
      const matchingReference = input.resourceAdditionalContext.find(
        (reference) => reference.logicalResourceId === externalReadSlice.logicalResourceId,
      )
      if (!matchingReference
        || matchingReference.currentVersion !== externalReadSlice.currentVersion
        || matchingReference.currentDigest !== externalReadSlice.currentDigest
        || matchingReference.supersedesVersion !== null
        || matchingReference.policyEpoch !== externalReadSlice.policyEpoch
        || externalReadSlice.allowedToolNames.some(
          (toolName) => !input.readyTurnToolAuthorization.allowedToolNames.includes(toolName),
        )) {
        return { ok: false, code: 'invalid_product_ingress' }
      }
    }
    for (const authority of resourceAuthorities) {
      const matchingReference = input.resourceAdditionalContext.find(
        (reference) => reference.logicalResourceId === authority.logicalResourceId,
      )
      const hasAuthorizedConsumer = authority.allowedToolNames.some(
        (toolName) => input.readyTurnToolAuthorization.allowedToolNames.includes(toolName),
      ) || (
        input.readyTurnToolAuthorization.allowedToolNames.includes('tag_forge_prepare_batch')
        && (
          authority.kind === 'local_directory'
          || (authority.kind === 'local_file' && authority.path.toLowerCase().endsWith('.md'))
        )
      )
      if (!matchingReference
        || matchingReference.currentVersion !== authority.currentVersion
        || matchingReference.currentDigest !== authority.currentDigest
        || matchingReference.policyEpoch !== authority.policyEpoch
        || !hasAuthorizedConsumer) {
        return { ok: false, code: 'invalid_product_ingress' }
      }
    }

    const ingress: CodexTurnIngress = {
          kind: 'user_ingress',
          attemptKind: input.explicitRetry ? 'explicit_retry' : 'user_ingress',
          originUserMessageId: input.originUserMessageId as string,
          canonicalCurrentInputRef,
          explicitResourceEnvelope: input.explicitResourceEnvelope,
          resourceAdditionalContext: input.resourceAdditionalContext,
          ...(currentDocumentAnchor ? { currentDocumentAnchor } : {}),
          ...(input.uncommittedUserTail?.length
            ? { uncommittedUserTail: input.uncommittedUserTail }
            : {}),
          ...(input.actionAdmissionRef ? { actionAdmissionRef: input.actionAdmissionRef } : {}),
          uncommittedTailAssignments: input.uncommittedTailAssignments,
          supersededUncommittedItems: input.supersededUncommittedItems,
          ...(explicitRetryIngress || {}),
        }

    return {
      ok: true,
      prepared: {
        preparationContract: 'codex_product_run_e2',
        taskId: input.taskId,
        runId: input.runId,
        conversationAlias: {
          aliasId: input.aliasId,
          aliasGeneration: input.aliasGeneration,
        },
        ingressBinding: {
          requestId: input.requestId,
          reservationSetId: input.reservationSetId,
          reservationEvidenceDigest: input.reservationEvidenceDigest,
        },
        ingress,
        resourceAnchorDigest: digest({
              explicitResourceEnvelope: input.explicitResourceEnvelope,
              resourceAdditionalContext: input.resourceAdditionalContext,
              ...(currentDocumentAnchor ? { currentDocumentAnchor } : {}),
              ...(externalReadSlice
                ? { externalReadResourceAuthority: externalReadResourceAuthority(externalReadSlice) }
                : {}),
              ...(resourceAuthorities.length > 0 ? { resourceAuthorities } : {}),
              ...(input.browserPageRef ? { browserPageRef: input.browserPageRef } : {}),
            }),
        sourceTrustedEnvironmentRef: input.explicitRetry?.sourceTrustedEnvironmentRef || {
          workbenchMode: input.trustedWorkbenchMode,
          environmentDigest: digest({
            workbenchMode: input.trustedWorkbenchMode,
            explicitResourceEnvelope: input.explicitResourceEnvelope,
            resourceAdditionalContext: input.resourceAdditionalContext,
            currentDocumentAnchor,
            externalReadSlice,
            resourceAuthorities,
            browserPageRef: input.browserPageRef || null,
            productSurfaceTargets: input.productSurfaceTargets || null,
          }),
        },
        actionAuthorizationMode: parseActionAuthorizationMode(input.actionAuthorizationMode),
        readyMemorySnapshot: input.readyMemorySnapshot,
        readyToolSurface: input.readyToolSurface,
        readyTurnToolAuthorization: input.readyTurnToolAuthorization,
        readyToolHostIdentity: {
          scopeId: input.scopeId,
          aliasId: input.aliasId,
          authorizationOwnerId: input.authorizationOwnerId,
          resourceOwnerId: input.resourceOwnerId,
        },
        ...(externalReadSlice ? { externalReadSlice } : {}),
        ...(resourceAuthorities.length > 0 ? { resourceAuthorities } : {}),
        ...(outputContract ? { outputContract } : {}),
        ...(input.browserPageRef ? { browserPageRef: input.browserPageRef } : {}),
        ...(input.productSurfaceTargets ? { productSurfaceTargets: input.productSurfaceTargets } : {}),
        actionObligations,
        ...(input.mcpCatalog ? { mcpCatalog: input.mcpCatalog } : {}),
        productBudgetSeed: createProductBudgetSeed(input.productBudgetSeed, outputContract !== null),
        neutralProjectionSeed: {
          phase: 'planning',
          taskTitle: '正在理解需求',
          taskSummary: '正在整理任务边界、资源与可用能力',
        },
      },
    }
  }
}
