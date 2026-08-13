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
  type CodexUserInput,
} from './codex-user-input'
import type {
  CodexTurnIngress,
  ExplicitResourceEnvelope,
  ResourceVersionReference,
} from './codex-turn-input-builder'
import { resourceReferenceSetsMatch } from './codex-turn-input-builder'
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

export type ReadyToolSurfaceRef = ReadyToolSurface

export type ReadyTurnToolAuthorizationRef = ReadyTurnToolAuthorization

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
  ingress: Extract<CodexTurnIngress, { kind: 'user_ingress' }>
  resourceAnchorDigest: string
  recoveredContextDigest: null
  actionAuthorizationMode?: ActionAuthorizationMode
  readyToolSurface: ReadyToolSurfaceRef
  readyTurnToolAuthorization: ReadyTurnToolAuthorizationRef
  readyToolHostIdentity: ReadyToolHostIdentity
  externalReadSlice?: PreparedCodexExternalReadSlice
  resourceAuthorities?: PreparedCodexResourceAuthority[]
  browserPageRef?: NonNullable<TrustedRequestEnvironment['browserPageRef']>
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
  taskOrigin: 'user_root' | 'workflow_child'
  runOrigin: 'initial' | 'continuation' | 'scheduled_task' | 'handoff_takeover'
  originUserMessageId?: string
  reservationSetId: string
  reservationEvidenceDigest: string
  currentInput: CodexUserInput[]
  explicitResourceEnvelope: ExplicitResourceEnvelope
  resourceAdditionalContext: ResourceVersionReference[]
  currentDocumentAnchor?: CodexCurrentDocumentAnchor | null
  actionAuthorizationMode?: ActionAuthorizationMode
  readyToolSurface: ReadyToolSurfaceRef
  readyTurnToolAuthorization: ReadyTurnToolAuthorizationRef
  authorizationOwnerId: string
  resourceOwnerId: string
  externalReadSlice?: PreparedCodexExternalReadSlice | null
  resourceAuthorities?: PreparedCodexResourceAuthority[]
  browserPageRef?: NonNullable<TrustedRequestEnvironment['browserPageRef']>
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
  attemptKind: z.literal('user_ingress'),
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
  currentDocumentAnchor: codexCurrentDocumentAnchorSchema.nullable().optional(),
  actionAuthorizationMode: z.enum(['ask', 'auto', 'full']).optional(),
  readyToolSurface: readyToolSurfaceSchema,
  readyTurnToolAuthorization: readyTurnToolAuthorizationSchema,
  authorizationOwnerId: nonEmptyString,
  resourceOwnerId: nonEmptyString,
  externalReadSlice: preparedExternalReadSliceSchema.nullable().optional(),
  resourceAuthorities: z.array(preparedCodexResourceAuthoritySchema).optional(),
  browserPageRef: browserPageRefSchema.optional(),
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
  actionAuthorizationMode: z.enum(['ask', 'auto', 'full']).optional(),
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
  browserPageRef: browserPageRefSchema.optional(),
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
    && prepared.readyTurnToolAuthorization.allowedToolNames.every(
      (toolName) => prepared.readyToolSurface.toolNames.includes(toolName),
    )
    && prepared.ingress.originUserMessageId === prepared.ingress.canonicalCurrentInputRef.messageId
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
    if (currentDocumentAnchor && externalReadSlice) {
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
        || JSON.stringify(input.readyTurnToolAuthorization.allowedToolNames)
          !== JSON.stringify([...externalReadSlice.allowedToolNames].sort())) {
        return { ok: false, code: 'invalid_product_ingress' }
      }
    }
    for (const authority of resourceAuthorities) {
      const matchingReference = input.resourceAdditionalContext.find(
        (reference) => reference.logicalResourceId === authority.logicalResourceId,
      )
      if (!matchingReference
        || matchingReference.currentVersion !== authority.currentVersion
        || matchingReference.currentDigest !== authority.currentDigest
        || matchingReference.policyEpoch !== authority.policyEpoch
        || authority.allowedToolNames.some(
          (toolName) => !input.readyTurnToolAuthorization.allowedToolNames.includes(toolName),
        )) {
        return { ok: false, code: 'invalid_product_ingress' }
      }
    }

    const ingress: CodexTurnIngress = {
          kind: 'user_ingress',
          attemptKind: 'user_ingress',
          originUserMessageId: input.originUserMessageId as string,
          canonicalCurrentInputRef: {
            messageId: input.originUserMessageId as string,
            input: input.currentInput,
          },
          explicitResourceEnvelope: input.explicitResourceEnvelope,
          resourceAdditionalContext: input.resourceAdditionalContext,
          ...(currentDocumentAnchor ? { currentDocumentAnchor } : {}),
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
              ...(currentDocumentAnchor ? { currentDocumentAnchor } : {}),
              ...(externalReadSlice
                ? { externalReadResourceAuthority: externalReadResourceAuthority(externalReadSlice) }
                : {}),
              ...(resourceAuthorities.length > 0 ? { resourceAuthorities } : {}),
              ...(input.browserPageRef ? { browserPageRef: input.browserPageRef } : {}),
            }),
        recoveredContextDigest: null,
        actionAuthorizationMode: parseActionAuthorizationMode(input.actionAuthorizationMode),
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
        ...(input.browserPageRef ? { browserPageRef: input.browserPageRef } : {}),
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
