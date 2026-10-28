import { z } from 'zod'

import {
  codexCurrentDocumentAnchorSchema,
  type CodexCurrentDocumentAnchor,
} from '../../../../shared/ipc-contracts/agent-runtime'
import type { AIReasoningEffort } from '../../../../shared/ai-providers'
import { resolveExplicitRetryTailPlan } from './codex-history-continuity-policy'

import type {
  CodexAdditionalContextEntry,
  CodexTurnStartParams,
} from './codex-native-runtime'
import type { CodexRetryArtifactSource } from './codex-product-run-preparer'
import {
  codexUserInputSchema,
  digestCodexUserInput,
  type CodexUserInput,
} from './codex-user-input'
import {
  READY_MEMORY_ADDITIONAL_CONTEXT_KEY,
  canonicalReadyMemoryJson,
  readyMemoryPromptPayload,
  type ReadyMemorySnapshot,
} from '../ready-memory'
import { digestCanonicalJson } from './codex-model-gateway-contract'
import {
  CODEX_DOCUMENT_WIDGET_GUIDANCE_CONTRACT,
  CODEX_DOCUMENT_WIDGET_GUIDANCE_KEY,
} from './codex-document-widget-guidance'

export type ResourceVersionReference = {
  logicalResourceId: string
  currentVersion: string
  currentDigest: string
  supersedesVersion: string | null
  policyEpoch: number
}

export type CanonicalCurrentInputRef = {
  messageId: string
  input: CodexUserInput[]
}

export type ExplicitResourceEnvelope = {
  input: CodexUserInput[]
  resourceRefs: ResourceVersionReference[]
}

export type UserIngress = {
  kind: 'user_ingress'
  attemptKind: 'user_ingress' | 'explicit_retry'
  originUserMessageId: string
  canonicalCurrentInputRef: CanonicalCurrentInputRef
  explicitResourceEnvelope: ExplicitResourceEnvelope
  resourceAdditionalContext: ResourceVersionReference[]
  currentDocumentAnchor?: CodexCurrentDocumentAnchor | null
  uncommittedUserTail?: Array<{
    originUserMessageId: string
    input: CodexUserInput[]
    inputDigest: string
    policy: 'untrusted_text_history' | 'resource_restatement_required' | 'task_restatement_required'
  }>
  actionAdmissionRef?: {
    headProjectionDigest: string
    actionProjectionVersion: {
      scopeEpoch: number
      headGeneration: number
      actionProjectionSequence: number
    }
    actionHeadIdentity: {
      aliasId: string
      aliasGeneration: number
      threadBindingId: string
      headRevision: number
    }
  }
  uncommittedTailAssignments?: Array<{
    originUserMessageId: string
    inputDigest: string
    plan: 'deliver_untrusted_history' | 'replace_with_explicit_retry' | 'omit_from_current_run'
  }>
  supersededUncommittedItems?: Array<{
    originUserMessageId: string
    inputDigest: string
    policy: 'resource_restatement_required' | 'task_restatement_required'
  }>
  predecessorRunId?: string
  predecessorPresentationRef?: {
    readyRunId: string
    presentationDigest: string
  }
  controlAuditMessageRef?: {
    messageId: string
    inputDigest: string
  }
  modelVisibleRootOriginRef?: {
    sourceReadyRunId: string
    sourceIngressContractDigest: string
    originUserMessageId: string
    inputDigest: string
  }
  selectedHistorySeedItemRef?: {
    threadBindingId: string
    historySeedDigest: string
    originUserMessageId: string
    inputDigest: string
  }
  currentTrustedEnvironmentRef?: {
    requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
    trustedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
    modeDigest: string
  }
  historyParityEvidenceDigest?: string
  currentThreadReadEvidenceDigest?: string
  continuationContractDigest?: string
  taskRootInput?: CodexUserInput[]
  taskRootInputDigest?: string
  artifactSources?: CodexRetryArtifactSource[]
}

export type NonUserSuccessorIngress = {
  kind: 'non_user_successor'
  attemptKind: 'recovery_successor' | 'checkpoint_successor'
  originUserMessageId: string
  predecessorRunId: string
  turnStartInput: []
  signedContinuationContextRef: string
  historyParityEvidenceDigest: string
  currentThreadReadEvidenceDigest: string
  continuationContractDigest: string
}

export type CodexTurnIngress = UserIngress | NonUserSuccessorIngress

export type CodexTurnBuildContext = {
  threadId: string
  turnRequestId: string
  reasoningEffort: AIReasoningEffort | null
  readyRunId: string
  toolSurfaceDigest: string
  turnContractDigest: string
  upstreamProfileSnapshotDigest: string
  readyMemorySnapshot: ReadyMemorySnapshot
  /** Ready's widget catalog, for a turn authorized to insert widgets (`codexDocumentWidgetGuidance`). */
  documentWidgetGuidance?: string | null
}

export type CodexTurnInputBuildResult =
  | { ok: true; params: CodexTurnStartParams }
  | {
      ok: false
      code:
        | 'invalid_ingress'
        | 'origin_message_mismatch'
        | 'resource_reference_mismatch'
        | 'non_user_successor_unsupported'
    }

const nonEmptyString = z.string().min(1)

const resourceVersionReferenceSchema = z.object({
  logicalResourceId: nonEmptyString,
  currentVersion: nonEmptyString,
  currentDigest: nonEmptyString,
  supersedesVersion: nonEmptyString.nullable(),
  policyEpoch: z.number().int().positive(),
}).strict()

const actionAdmissionRefSchema = z.object({
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
}).strict()

const uncommittedTailItemSchema = z.object({
  originUserMessageId: nonEmptyString,
  input: z.array(codexUserInputSchema).min(1),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policy: z.enum([
    'untrusted_text_history',
    'resource_restatement_required',
    'task_restatement_required',
  ]),
}).strict().superRefine((item, context) => {
  if (item.policy === 'untrusted_text_history'
    && item.input.some((input) => input.type !== 'text')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'untrusted tail must be text' })
  }
})

const tailAssignmentSchema = z.object({
  originUserMessageId: nonEmptyString,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  plan: z.enum([
    'deliver_untrusted_history',
    'replace_with_explicit_retry',
    'omit_from_current_run',
  ]),
}).strict()

const supersededTailItemSchema = z.object({
  originUserMessageId: nonEmptyString,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policy: z.enum(['resource_restatement_required', 'task_restatement_required']),
}).strict()

const userIngressSchema = z.object({
  kind: z.literal('user_ingress'),
  attemptKind: z.literal('user_ingress'),
  originUserMessageId: nonEmptyString,
  canonicalCurrentInputRef: z.object({
    messageId: nonEmptyString,
    input: z.array(codexUserInputSchema).min(1),
  }).strict(),
  explicitResourceEnvelope: z.object({
    input: z.array(codexUserInputSchema),
    resourceRefs: z.array(resourceVersionReferenceSchema),
  }).strict(),
  resourceAdditionalContext: z.array(resourceVersionReferenceSchema),
  currentDocumentAnchor: codexCurrentDocumentAnchorSchema.nullable().optional(),
  uncommittedUserTail: z.array(uncommittedTailItemSchema).min(1).max(8).optional(),
  actionAdmissionRef: actionAdmissionRefSchema,
  uncommittedTailAssignments: z.array(tailAssignmentSchema).max(8),
  supersededUncommittedItems: z.array(supersededTailItemSchema).max(8),
}).strict()

const explicitRetryIngressSchema = userIngressSchema.extend({
  attemptKind: z.literal('explicit_retry'),
  actionAdmissionRef: z.never().optional(),
  predecessorRunId: nonEmptyString,
  predecessorPresentationRef: z.object({
    readyRunId: nonEmptyString,
    presentationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  controlAuditMessageRef: z.object({
    messageId: nonEmptyString,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  modelVisibleRootOriginRef: z.object({
    sourceReadyRunId: nonEmptyString,
    sourceIngressContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
    originUserMessageId: nonEmptyString,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  selectedHistorySeedItemRef: z.object({
    threadBindingId: nonEmptyString,
    historySeedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    originUserMessageId: nonEmptyString,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  currentTrustedEnvironmentRef: z.object({
    requestedWorkbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']),
    trustedWorkbenchMode: z.enum(['browser', 'document', 'rss', 'calendar']),
    modeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  historyParityEvidenceDigest: nonEmptyString,
  currentThreadReadEvidenceDigest: nonEmptyString,
  continuationContractDigest: nonEmptyString,
  taskRootInput: z.array(codexUserInputSchema).min(1),
  taskRootInputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  artifactSources: z.tuple([]),
}).strict()

const nonUserSuccessorIngressSchema = z.object({
  kind: z.literal('non_user_successor'),
  attemptKind: z.enum(['recovery_successor', 'checkpoint_successor']),
  originUserMessageId: nonEmptyString,
  predecessorRunId: nonEmptyString,
  turnStartInput: z.tuple([]),
  signedContinuationContextRef: nonEmptyString,
  historyParityEvidenceDigest: nonEmptyString,
  currentThreadReadEvidenceDigest: nonEmptyString,
  continuationContractDigest: nonEmptyString,
}).strict()

const codexTurnIngressSchema = z.union([
  userIngressSchema,
  explicitRetryIngressSchema,
  nonUserSuccessorIngressSchema,
])

function referenceKey(reference: ResourceVersionReference): string {
  return JSON.stringify([
    reference.logicalResourceId,
    reference.currentVersion,
    reference.currentDigest,
    reference.supersedesVersion,
    reference.policyEpoch,
  ])
}

export function resourceReferenceSetsMatch(
  envelopeReferences: readonly ResourceVersionReference[],
  additionalContextReferences: readonly ResourceVersionReference[],
): boolean {
  const envelopeRefs = new Set(envelopeReferences.map(referenceKey))
  const contextRefs = new Set(additionalContextReferences.map(referenceKey))
  const envelopeResourceIds = new Set(
    envelopeReferences.map((reference) => reference.logicalResourceId),
  )
  const contextResourceIds = new Set(
    additionalContextReferences.map((reference) => reference.logicalResourceId),
  )
  return envelopeRefs.size === envelopeReferences.length
    && contextRefs.size === additionalContextReferences.length
    && envelopeResourceIds.size === envelopeReferences.length
    && contextResourceIds.size === additionalContextReferences.length
    && envelopeRefs.size === contextRefs.size
    && [...envelopeRefs].every((key) => contextRefs.has(key))
}

function buildResourceContext(
  references: ResourceVersionReference[],
  readyRunId: string,
): Record<string, CodexAdditionalContextEntry> {
  // Native additionalContext is a diff: bind the complete snapshot to this run
  // so unchanged resources are still emitted before each new user message.
  return references.length === 0 ? {} : {
    'ready-resource-context': { kind: 'application', value: JSON.stringify({
      contract: 'ready_resource_context_v1', readyRunId, references,
    }) },
  }
}

export function buildCodexExplicitRetryContext(input: UserIngress) {
  if (
    input.attemptKind !== 'explicit_retry'
    || !input.predecessorRunId
    || !input.historyParityEvidenceDigest
    || !input.currentThreadReadEvidenceDigest
    || !input.continuationContractDigest
    || !input.taskRootInput
    || !input.taskRootInputDigest
    || digestCodexUserInput(input.taskRootInput) !== input.taskRootInputDigest
    || !input.predecessorPresentationRef
    || !input.controlAuditMessageRef
    || !input.modelVisibleRootOriginRef
    || !input.selectedHistorySeedItemRef
    || !input.currentTrustedEnvironmentRef
    || input.artifactSources?.length !== 0
  ) throw new Error('codex_explicit_retry_context_invalid')
  return {
    predecessorRunId: input.predecessorRunId,
    predecessorPresentationRef: input.predecessorPresentationRef,
    controlAuditMessageRef: input.controlAuditMessageRef,
    modelVisibleRootOriginRef: input.modelVisibleRootOriginRef,
    selectedHistorySeedItemRef: input.selectedHistorySeedItemRef,
    currentTrustedEnvironmentRef: input.currentTrustedEnvironmentRef,
    historyParityEvidenceDigest: input.historyParityEvidenceDigest,
    currentThreadReadEvidenceDigest: input.currentThreadReadEvidenceDigest,
    continuationContractDigest: input.continuationContractDigest,
    taskRootInputDigest: input.taskRootInputDigest,
  }
}

export type CodexDeliveredUserTail = {
  contract: 'ready_uncommitted_user_tail_v2'
  readyRunId: string
  originUserMessageId: string
  input: CodexUserInput[]
  inputDigest: string
}

export function buildCodexDeliveredUserTail(ingress: UserIngress, readyRunId: string): CodexDeliveredUserTail[] {
  return (ingress.uncommittedUserTail || []).filter((item) => (
    ingress.uncommittedTailAssignments?.some((assignment) => (
      assignment.originUserMessageId === item.originUserMessageId
      && assignment.inputDigest === item.inputDigest
      && assignment.plan === 'deliver_untrusted_history'
    ))
  )).map((item) => ({
    contract: 'ready_uncommitted_user_tail_v2',
    readyRunId,
    originUserMessageId: item.originUserMessageId,
    input: item.input,
    inputDigest: item.inputDigest,
  }))
}

export class CodexTurnInputBuilder {
  build(rawIngress: unknown, context: CodexTurnBuildContext): CodexTurnInputBuildResult {
    const parsed = codexTurnIngressSchema.safeParse(rawIngress)
    if (!parsed.success) return { ok: false, code: 'invalid_ingress' }
    const ingress = parsed.data

    if (ingress.kind === 'non_user_successor') {
      return { ok: false, code: 'non_user_successor_unsupported' }
    }
    if (ingress.attemptKind === 'user_ingress'
      && ingress.canonicalCurrentInputRef.messageId !== ingress.originUserMessageId) {
      return { ok: false, code: 'origin_message_mismatch' }
    }

    if (!resourceReferenceSetsMatch(
      ingress.explicitResourceEnvelope.resourceRefs,
      ingress.resourceAdditionalContext,
    )) {
      return { ok: false, code: 'resource_reference_mismatch' }
    }
    if (ingress.attemptKind === 'explicit_retry'
      && (digestCodexUserInput(ingress.taskRootInput) !== ingress.taskRootInputDigest
        || ingress.canonicalCurrentInputRef.messageId
          !== ingress.modelVisibleRootOriginRef.originUserMessageId
        || digestCodexUserInput(ingress.canonicalCurrentInputRef.input)
          !== ingress.modelVisibleRootOriginRef.inputDigest
        || ingress.taskRootInputDigest !== ingress.modelVisibleRootOriginRef.inputDigest
        || ingress.selectedHistorySeedItemRef.originUserMessageId
          !== ingress.modelVisibleRootOriginRef.originUserMessageId
        || ingress.selectedHistorySeedItemRef.inputDigest
          !== ingress.modelVisibleRootOriginRef.inputDigest
        || ingress.controlAuditMessageRef.messageId !== ingress.originUserMessageId
        || ingress.currentTrustedEnvironmentRef.requestedWorkbenchMode
          !== ingress.currentTrustedEnvironmentRef.trustedWorkbenchMode
        || ingress.currentTrustedEnvironmentRef.modeDigest !== digestCanonicalJson({
          requestedWorkbenchMode: ingress.currentTrustedEnvironmentRef.requestedWorkbenchMode,
          trustedWorkbenchMode: ingress.currentTrustedEnvironmentRef.trustedWorkbenchMode,
        })
        || ingress.predecessorPresentationRef.readyRunId !== ingress.predecessorRunId)) {
      return { ok: false, code: 'invalid_ingress' }
    }
    if (ingress.uncommittedUserTail?.some(
      (item) => digestCodexUserInput(item.input) !== item.inputDigest,
    )) return { ok: false, code: 'invalid_ingress' }
    const tail = ingress.uncommittedUserTail || []
    const assignments = ingress.uncommittedTailAssignments || []
    if (tail.length !== assignments.length
      || new Set(assignments.map((item) => item.originUserMessageId)).size !== assignments.length
      || tail.some((item) => !assignments.some((assignment) => (
        assignment.originUserMessageId === item.originUserMessageId
        && assignment.inputDigest === item.inputDigest
      )))) return { ok: false, code: 'invalid_ingress' }
    if (ingress.attemptKind === 'user_ingress') {
      const expectedSuperseded = tail.filter((item) => item.policy !== 'untrusted_text_history')
      if (tail.some((item) => assignments.find(
        (assignment) => assignment.originUserMessageId === item.originUserMessageId,
      )?.plan !== (item.policy === 'untrusted_text_history'
        ? 'deliver_untrusted_history'
        : 'omit_from_current_run'))
        || ingress.supersededUncommittedItems.length !== expectedSuperseded.length
        || expectedSuperseded.some((item) => !ingress.supersededUncommittedItems.some(
          (superseded) => superseded.originUserMessageId === item.originUserMessageId
            && superseded.inputDigest === item.inputDigest
            && superseded.policy === item.policy,
        ))) return { ok: false, code: 'invalid_ingress' }
    } else {
      const plan = resolveExplicitRetryTailPlan(tail, ingress.selectedHistorySeedItemRef)
      if (plan.kind !== 'eligible' || ingress.supersededUncommittedItems.length !== 0
        || digestCanonicalJson(assignments) !== digestCanonicalJson(plan.assignments)) {
        return { ok: false, code: 'invalid_ingress' }
      }
    }

    const readyMemoryPayload = readyMemoryPromptPayload(context.readyMemorySnapshot)
    return {
      ok: true,
      params: {
        threadId: context.threadId,
        clientUserMessageId: context.turnRequestId,
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'ready-e0-model',
            reasoning_effort: context.reasoningEffort,
            developer_instructions: null,
          },
        },
        environments: [],
        input: [
          ...ingress.canonicalCurrentInputRef.input,
          ...ingress.explicitResourceEnvelope.input,
        ],
        additionalContext: {
          ...buildResourceContext(ingress.resourceAdditionalContext, context.readyRunId),
          ...Object.fromEntries(buildCodexDeliveredUserTail(ingress, context.readyRunId).map((item, index) => [
            `ready-uncommitted-user-tail:${index}`,
            {
              kind: 'untrusted' as const,
              value: JSON.stringify(item),
            },
          ])),
          ...(ingress.attemptKind === 'explicit_retry'
            ? {
                'ready-explicit-retry': {
                  kind: 'application' as const,
                  value: JSON.stringify(buildCodexExplicitRetryContext(ingress)),
                },
              }
            : {}),
          ...(context.documentWidgetGuidance
            ? {
                // The run id makes the value differ every turn; Codex drops context whose key and value repeat.
                [CODEX_DOCUMENT_WIDGET_GUIDANCE_KEY]: {
                  kind: 'application' as const,
                  value: JSON.stringify({
                    contract: CODEX_DOCUMENT_WIDGET_GUIDANCE_CONTRACT,
                    readyRunId: context.readyRunId,
                    guidance: context.documentWidgetGuidance,
                  }),
                },
              }
            : {}),
          ...(readyMemoryPayload
            ? {
                [READY_MEMORY_ADDITIONAL_CONTEXT_KEY]: {
                  kind: 'application' as const,
                  value: canonicalReadyMemoryJson(readyMemoryPayload),
                },
              }
            : {}),
        },
        responsesapiClientMetadata: {
          readyRunId: context.readyRunId,
          toolSurfaceDigest: context.toolSurfaceDigest,
          turnContractDigest: context.turnContractDigest,
          upstreamProfileSnapshotDigest: context.upstreamProfileSnapshotDigest,
        },
      },
    }
  }
}

export function textUserInput(text: string): CodexUserInput {
  return { type: 'text', text, text_elements: [] }
}
