import { createHash } from 'node:crypto'
import { z } from 'zod'

import type { CodexUserInput } from './codex-native-runtime'
import type {
  CodexTurnIngress,
  ExplicitResourceEnvelope,
  ResourceVersionReference,
} from './codex-turn-input-builder'
import { resourceReferenceSetsMatch } from './codex-turn-input-builder'

export type ReadyToolSurfaceRef = {
  surfaceId: string
  toolSurfaceDigest: string
  toolNames: string[]
}

export type ReadyTurnToolAuthorizationRef = {
  authorizationId: string
  authorizationDigest: string
}

export type ReadyToolHostIdentity = {
  scopeId: string
  aliasId: string
  authorizationOwnerId: string
  resourceOwnerId: string
}

export type PreparedCodexProductRun = {
  preparationContract: 'codex_product_run_e1'
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
  ingress: CodexTurnIngress
  resourceAnchorDigest: string
  recoveredContextDigest: null
  readyToolSurface: ReadyToolSurfaceRef
  readyTurnToolAuthorization: ReadyTurnToolAuthorizationRef
  readyToolHostIdentity: ReadyToolHostIdentity
  productBudgetSeed: {
    maxIterations: number
    maxToolCalls: number
    maxParallelToolGroups: number
  }
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
  taskOrigin: 'user_root' | 'system_background' | 'workflow_child'
  runOrigin: 'initial' | 'continuation' | 'scheduled_task' | 'handoff_takeover'
  originUserMessageId: string
  reservationSetId: string
  reservationEvidenceDigest: string
  currentInput: CodexUserInput[]
  explicitResourceEnvelope: ExplicitResourceEnvelope
  resourceAdditionalContext: ResourceVersionReference[]
  readyToolSurface: ReadyToolSurfaceRef
  readyTurnToolAuthorization: ReadyTurnToolAuthorizationRef
  authorizationOwnerId: string
  resourceOwnerId: string
  productBudgetSeed: {
    maxIterations: number
    maxToolCalls: number
    maxParallelToolGroups: number
  }
}

export type CodexProductRunPreparationResult =
  | { ok: true; prepared: PreparedCodexProductRun }
  | { ok: false; code: 'unsupported_product_ingress' | 'invalid_product_ingress' }

const nonEmptyString = z.string().min(1)
const userInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), text_elements: z.tuple([]) }).strict(),
  z.object({
    type: z.literal('image'),
    url: nonEmptyString,
    detail: z.enum(['auto', 'low', 'high', 'original']).nullable(),
  }).strict(),
  z.object({ type: z.literal('audio'), url: nonEmptyString }).strict(),
])
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
const userIngressPreparationSchema = z.object({
  kind: z.literal('user_ingress'),
  attemptKind: z.literal('user_ingress'),
  originUserMessageId: nonEmptyString,
  canonicalCurrentInputRef: z.object({
    messageId: nonEmptyString,
    input: z.array(userInputSchema).min(1),
  }).strict(),
  explicitResourceEnvelope: z.object({
    input: z.array(userInputSchema),
    resourceRefs: z.array(resourceRefSchema),
  }).strict(),
  resourceAdditionalContext: z.array(resourceRefSchema),
}).strict()
const preparationInputSchema = z.object({
  taskId: nonEmptyString,
  runId: nonEmptyString,
  requestId: nonEmptyString,
  scopeId: nonEmptyString,
  aliasId: nonEmptyString,
  aliasGeneration: z.number().int().positive(),
  taskOrigin: z.enum(['user_root', 'system_background', 'workflow_child']),
  runOrigin: z.enum(['initial', 'continuation', 'scheduled_task', 'handoff_takeover']),
  originUserMessageId: nonEmptyString,
  reservationSetId: nonEmptyString,
  reservationEvidenceDigest: nonEmptyString,
  currentInput: z.array(userInputSchema).min(1),
  explicitResourceEnvelope: z.object({
    input: z.array(userInputSchema),
    resourceRefs: z.array(resourceRefSchema),
  }).strict(),
  resourceAdditionalContext: z.array(resourceRefSchema),
  readyToolSurface: z.object({
    surfaceId: nonEmptyString,
    toolSurfaceDigest: nonEmptyString,
    toolNames: z.array(nonEmptyString),
  }).strict(),
  readyTurnToolAuthorization: z.object({
    authorizationId: nonEmptyString,
    authorizationDigest: nonEmptyString,
  }).strict(),
  authorizationOwnerId: nonEmptyString,
  resourceOwnerId: nonEmptyString,
  productBudgetSeed: budgetSeedSchema,
}).strict()
const preparedRunSchema = z.object({
  preparationContract: z.literal('codex_product_run_e1'),
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
  recoveredContextDigest: z.null(),
  readyToolSurface: z.object({
    surfaceId: nonEmptyString,
    toolSurfaceDigest: nonEmptyString,
    toolNames: z.array(nonEmptyString),
  }).strict(),
  readyTurnToolAuthorization: z.object({
    authorizationId: nonEmptyString,
    authorizationDigest: nonEmptyString,
  }).strict(),
  readyToolHostIdentity: z.object({
    scopeId: nonEmptyString,
    aliasId: nonEmptyString,
    authorizationOwnerId: nonEmptyString,
    resourceOwnerId: nonEmptyString,
  }).strict(),
  productBudgetSeed: budgetSeedSchema,
  neutralProjectionSeed: z.object({
    phase: z.literal('planning'),
    taskTitle: z.literal('正在理解需求'),
    taskSummary: z.literal('正在整理任务边界、资源与可用能力'),
  }).strict(),
}).strict()

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function isPreparedCodexProductRun(value: unknown): value is PreparedCodexProductRun {
  const parsed = preparedRunSchema.safeParse(value)
  if (!parsed.success) return false
  const prepared = parsed.data
  return prepared.conversationAlias.aliasId === prepared.readyToolHostIdentity.aliasId
    && prepared.ingress.originUserMessageId === prepared.ingress.canonicalCurrentInputRef.messageId
    && resourceReferenceSetsMatch(
      prepared.ingress.explicitResourceEnvelope.resourceRefs,
      prepared.ingress.resourceAdditionalContext,
    )
    && prepared.resourceAnchorDigest === digest({
      explicitResourceEnvelope: prepared.ingress.explicitResourceEnvelope,
      resourceAdditionalContext: prepared.ingress.resourceAdditionalContext,
    })
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
    && value.ingress.originUserMessageId === expected.originUserMessageId
}

export class CodexProductRunPreparer {
  prepare(rawInput: unknown): CodexProductRunPreparationResult {
    const parsed = preparationInputSchema.safeParse(rawInput)
    if (!parsed.success) return { ok: false, code: 'invalid_product_ingress' }
    const input = parsed.data
    if (input.taskOrigin !== 'user_root' || input.runOrigin !== 'initial') {
      return { ok: false, code: 'unsupported_product_ingress' }
    }
    if (!resourceReferenceSetsMatch(
      input.explicitResourceEnvelope.resourceRefs,
      input.resourceAdditionalContext,
    )) {
      return { ok: false, code: 'invalid_product_ingress' }
    }

    const ingress: CodexTurnIngress = {
      kind: 'user_ingress',
      attemptKind: 'user_ingress',
      originUserMessageId: input.originUserMessageId,
      canonicalCurrentInputRef: {
        messageId: input.originUserMessageId,
        input: input.currentInput,
      },
      explicitResourceEnvelope: input.explicitResourceEnvelope,
      resourceAdditionalContext: input.resourceAdditionalContext,
    }

    return {
      ok: true,
      prepared: {
        preparationContract: 'codex_product_run_e1',
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
        }),
        recoveredContextDigest: null,
        readyToolSurface: input.readyToolSurface,
        readyTurnToolAuthorization: input.readyTurnToolAuthorization,
        readyToolHostIdentity: {
          scopeId: input.scopeId,
          aliasId: input.aliasId,
          authorizationOwnerId: input.authorizationOwnerId,
          resourceOwnerId: input.resourceOwnerId,
        },
        productBudgetSeed: input.productBudgetSeed,
        neutralProjectionSeed: {
          phase: 'planning',
          taskTitle: '正在理解需求',
          taskSummary: '正在整理任务边界、资源与可用能力',
        },
      },
    }
  }
}
