import { z } from 'zod'

import {
  codexCurrentDocumentAnchorSchema,
  type CodexCurrentDocumentAnchor,
} from '../../../../shared/ipc-contracts/agent-runtime'
import type { AIReasoningEffort } from '../../../../shared/ai-providers'

import type {
  CodexAdditionalContextEntry,
  CodexTurnStartParams,
} from './codex-native-runtime'
import type { CodexRetryArtifactSource } from './codex-product-run-preparer'
import {
  codexUserInputSchema,
  type CodexUserInput,
} from './codex-user-input'
import {
  READY_MEMORY_ADDITIONAL_CONTEXT_KEY,
  canonicalReadyMemoryJson,
  readyMemoryPromptPayload,
  type ReadyMemorySnapshot,
} from '../ready-memory'

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
  predecessorRunId?: string
  historyParityEvidenceDigest?: string
  currentThreadReadEvidenceDigest?: string
  continuationContractDigest?: string
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
}).strict()

const explicitRetryIngressSchema = userIngressSchema.extend({
  attemptKind: z.literal('explicit_retry'),
  predecessorRunId: nonEmptyString,
  historyParityEvidenceDigest: nonEmptyString,
  currentThreadReadEvidenceDigest: nonEmptyString,
  continuationContractDigest: nonEmptyString,
  artifactSources: z.array(z.object({
    sourceReadyRunId: nonEmptyString,
    relativePath: nonEmptyString,
    logicalArtifactRef: nonEmptyString,
    version: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['staged', 'exported', 'verified', 'indeterminate']),
  }).strict()).max(8),
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
): Record<string, CodexAdditionalContextEntry> {
  return Object.fromEntries(references.map((reference) => [
    `ready-resource:${reference.logicalResourceId}`,
    {
      kind: 'application' as const,
      value: JSON.stringify(reference),
    },
  ]))
}

export function buildCodexExplicitRetryContext(input: UserIngress) {
  if (
    input.attemptKind !== 'explicit_retry'
    || !input.predecessorRunId
    || !input.historyParityEvidenceDigest
    || !input.currentThreadReadEvidenceDigest
    || !input.continuationContractDigest
    || !input.artifactSources
  ) throw new Error('codex_explicit_retry_context_invalid')
  return {
    predecessorRunId: input.predecessorRunId,
    historyParityEvidenceDigest: input.historyParityEvidenceDigest,
    currentThreadReadEvidenceDigest: input.currentThreadReadEvidenceDigest,
    continuationContractDigest: input.continuationContractDigest,
    artifactSources: input.artifactSources,
  }
}

export class CodexTurnInputBuilder {
  build(rawIngress: unknown, context: CodexTurnBuildContext): CodexTurnInputBuildResult {
    const parsed = codexTurnIngressSchema.safeParse(rawIngress)
    if (!parsed.success) return { ok: false, code: 'invalid_ingress' }
    const ingress = parsed.data

    if (ingress.kind === 'non_user_successor') {
      return { ok: false, code: 'non_user_successor_unsupported' }
    }
    if (ingress.canonicalCurrentInputRef.messageId !== ingress.originUserMessageId) {
      return { ok: false, code: 'origin_message_mismatch' }
    }

    if (!resourceReferenceSetsMatch(
      ingress.explicitResourceEnvelope.resourceRefs,
      ingress.resourceAdditionalContext,
    )) {
      return { ok: false, code: 'resource_reference_mismatch' }
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
          ...buildResourceContext(ingress.resourceAdditionalContext),
          ...(ingress.attemptKind === 'explicit_retry'
            ? {
                'ready-explicit-retry': {
                  kind: 'application' as const,
                  value: JSON.stringify(buildCodexExplicitRetryContext(ingress)),
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
