import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AIModelConfig } from '../../../../shared/ai-providers'
import { isBrowserPublicToolName } from '../../../../shared/browser-capability-registry'
import {
  DEFAULT_ACTION_AUTHORIZATION_MODE,
  parseActionAuthorizationMode,
  type ActionAuthorizationMode,
} from '../../../../shared/action-authorization-mode'
import type { SendScopedRequest } from '../../../../shared/ipc-contracts/agent-runtime'
import type { RunMessage } from '../contracts/run-contracts'
import {
  buildRequestEnvelope,
  type RequestEnvelope,
  type RequestEnvelopeResource,
} from '../contracts/request-envelope'
import type { IntentClassification } from '../intent-classifier'
import { composeCodexTurnToolSnapshot } from './codex-tool-surface-composition'
import { isCodexFolderTagForgeAlias } from './codex-folder-tag-forge-alias'
import {
  buildSelectedSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../skills/skill-tool-authorization'
import { digestCanonicalJson, instructionTranscriptDigest } from './codex-model-gateway-contract'
import { createCodexProfileRouteSnapshot } from './codex-profile-admission'
import { sha256 } from './codex-product-surface-ingress'
import { CodexToolBridgeError } from './codex-tool-bridge'
import type { ReadyToolTurnSnapshot } from './codex-tool-surface'
import {
  type PreparedCodexExternalReadSlice,
} from './codex-external-read-slice'
import type { BrowserWorkflowVerifierInspection, BrowserWorkflowVerifierBundle } from '../../repositories/agent-session-checkpoint-types'
import type { PreparedCodexProductRun } from './codex-product-run-preparer'
import type { CodexProductTurnRuntimeRead } from './codex-binding-repository'
import type { CodexRuntimeIngressGate } from './codex-runtime-boot-reconciler'
import type { CodexRuntimeHostPort } from './codex-runtime-composition'
import type { CodexRendererToolActionRequester } from './codex-product-surface-ingress'
import type { CodexUserInput } from './codex-user-input'
import type { CodexCurrentDocumentAnchor } from '../../../../shared/ipc-contracts/agent-runtime'
import {
  buildCodexThreadDeveloperInstructions,
  CODEX_HOST_OVERLAY,
} from './codex-thread-instructions'

export function buildCodexProductRequestEnvelope(
  request: SendScopedRequest,
  actionAuthorizationMode: ActionAuthorizationMode = DEFAULT_ACTION_AUTHORIZATION_MODE,
  trustedEnvironment: import('../contracts/request-envelope').TrustedRequestEnvironment = {},
  trustedResources: readonly RequestEnvelopeResource[] = [],
  currentDocumentCanWrite = false,
): RequestEnvelope {
  const envelope = buildRequestEnvelope({
    userText: request.userMessage.content,
    sessionId: request.scopeId,
    scopeId: request.scopeId,
    trustedEnvironment,
    actionAuthorizationMode,
  })
  for (const resource of trustedResources) {
    envelope.resources.push({ ...resource, order: envelope.resources.length })
  }
  if (trustedResources.some((resource) => resource.kind === 'attachment')) {
    envelope.environmentHints.hasAttachments = true
  }
  const workspaceRoots = trustedResources
    .filter((resource) => resource.kind === 'folder_reference' && resource.canRead && resource.path)
    .map((resource) => resource.path as string)
  if (workspaceRoots.length > 0) envelope.environmentHints.workspaceRoots = workspaceRoots
  if (request.currentDocumentAnchor) {
    const anchor = request.currentDocumentAnchor
    envelope.resources.push({
      id: anchor.logicalResourceId,
      kind: 'document_context',
      source: 'current_document',
      name: anchor.title || '当前文档',
      path: null,
      tabId: anchor.tabId,
      text: '',
      summary: null,
      order: envelope.resources.length,
      canRead: true,
      canWrite: currentDocumentCanWrite,
    })
    envelope.environmentHints.hasDocumentContext = true
  }
  return envelope
}

export function resolveCodexProductTurnAuthorization(input: {
  host: Pick<CodexRuntimeHostPort, 'getScope' | 'resolveSkillAuthorizationForTurn'>
  request: SendScopedRequest
  scopeId: string
  externalReadSlice: PreparedCodexExternalReadSlice | null
  trustedEnvironment?: import('../contracts/request-envelope').TrustedRequestEnvironment
  trustedResources?: readonly RequestEnvelopeResource[]
  currentDocumentCanWrite?: boolean
}): { requestEnvelope: RequestEnvelope; authorization: SkillToolAuthorization } {
  const persistedScope = input.host.getScope(input.scopeId)
  if (!persistedScope) throw new Error('codex_conversation_scope_not_found')
  const actionAuthorizationMode = persistedScope.sourceKind === 'local'
    ? parseActionAuthorizationMode(persistedScope.meta.actionAuthorizationMode)
    : DEFAULT_ACTION_AUTHORIZATION_MODE
  let requestEnvelope = buildCodexProductRequestEnvelope(
    input.request,
    actionAuthorizationMode,
    input.trustedEnvironment,
    input.trustedResources,
    input.currentDocumentCanWrite,
  )
  let authorization = input.externalReadSlice?.kind === 'lark_cli_read'
    ? buildSelectedSkillToolAuthorization({
        skillId: 'lark-doc',
        allowedTypedActions: [],
        allowedPrimitives: input.externalReadSlice.allowedToolNames,
        source: 'explicit',
        reason: 'codex_external_read_slice',
      })
    : input.host.resolveSkillAuthorizationForTurn({
        message: toRunMessage(input.request),
        sessionId: input.scopeId,
        messageVisibilityEpoch: persistedScope.messageVisibilityEpoch,
        requestEnvelope,
      })
  if (
    authorization.mode === 'none'
    && isCodexFolderTagForgeAlias({
      userText: input.request.userMessage.content,
      hasTypedFolder: requestEnvelope.resources.some((resource) => resource.kind === 'folder_reference'),
    })
  ) {
    requestEnvelope = {
      ...requestEnvelope,
      resources: [
        ...requestEnvelope.resources,
        {
          id: `skill_reference-${requestEnvelope.resources.length}-tag-forge`,
          kind: 'skill_reference',
          source: 'explicit_reference',
          name: 'tag-forge',
          path: null,
          text: '',
          summary: null,
          order: requestEnvelope.resources.length,
          canRead: false,
          canWrite: false,
        },
      ],
    }
    authorization = input.host.resolveSkillAuthorizationForTurn({
      message: toRunMessage(input.request),
      sessionId: input.scopeId,
      messageVisibilityEpoch: persistedScope.messageVisibilityEpoch,
      requestEnvelope,
    })
  }
  return { requestEnvelope, authorization }
}

export function readCodexPreparedActionAuthorizationEnvelope(
  product: Pick<CodexProductTurnRuntimeRead, 'prepared'>,
): {
  actionAuthorizationMode: ActionAuthorizationMode
  resources?: Array<RequestEnvelopeResource & {
    currentVersion: string
    currentDigest: string
    policyEpoch: number
  }>
  environmentHints?: {
    workspaceRoots: string[]
    workbenchMode?: import('../contracts/request-envelope').TrustedRequestEnvironment['workbenchMode']
    browserPageRef?: NonNullable<import('../contracts/request-envelope').TrustedRequestEnvironment['browserPageRef']>
  }
  outputContract?: PreparedCodexProductRun['outputContract']
  retryArtifactSources?: import('./codex-product-run-preparer').CodexRetryArtifactSource[]
} {
  const authorities = product.prepared.resourceAuthorities ?? []
  const browserPageRef = product.prepared.browserPageRef
  return {
    actionAuthorizationMode: parseActionAuthorizationMode(
      product.prepared.actionAuthorizationMode,
    ),
    ...(product.prepared.outputContract
      ? { outputContract: product.prepared.outputContract }
      : {}),
    ...(product.prepared.ingress.attemptKind === 'explicit_retry'
      ? { retryArtifactSources: product.prepared.ingress.artifactSources ?? [] }
      : {}),
    ...(authorities.length > 0 || browserPageRef
      ? {
          ...(authorities.length > 0 ? {
            resources: authorities.map((authority, order) => ({
              id: authority.logicalResourceId,
              kind: authority.kind === 'local_directory' ? 'folder_reference' as const : 'attachment' as const,
              source: authority.kind === 'local_directory' ? 'folder_reference' as const : 'user_attachment' as const,
              name: authority.name,
              path: authority.path,
              text: '',
              summary: null,
              order,
              canRead: true,
              canWrite: false,
              currentVersion: authority.currentVersion,
              currentDigest: authority.currentDigest,
              policyEpoch: authority.policyEpoch,
            })),
          } : {}),
          environmentHints: {
            workspaceRoots: authorities
              .filter((authority) => authority.kind === 'local_directory')
              .map((authority) => authority.path),
            ...(browserPageRef ? { browserPageRef } : {}),
          },
        }
      : {}),
  }
}

export function createCodexProductUpstreamProfileSnapshot(input: {
  profileId: string
  config: AIModelConfig
}): ReturnType<typeof createCodexProfileRouteSnapshot> {
  return createCodexProfileRouteSnapshot(input)
}

export function resourceReferenceForAnchor(anchor: CodexCurrentDocumentAnchor) {
  return {
    logicalResourceId: anchor.logicalResourceId,
    currentVersion: anchor.currentVersion,
    currentDigest: anchor.currentDigest,
    supersedesVersion: anchor.supersedesVersion,
    policyEpoch: anchor.policyEpoch,
  }
}

export function buildCurrentDocumentReadToolSnapshot(input: {
  resolved: ReadyToolTurnSnapshot
  authorizationId: string
  authorization: SkillToolAuthorization
  allowWrite?: boolean
}): ReadyToolTurnSnapshot {
  return composeCodexTurnToolSnapshot({
    resolved: input.resolved,
    authorizationId: input.authorizationId,
    authorization: input.authorization,
    currentDocument: { present: true, allowWrite: input.allowWrite === true },
  })
}

export function hasExplicitCurrentDocumentWriteIntent(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  if (/(?:只|仅)(?:需|要)?(?:阅读|读取|查看|总结|概括|分析|检查|审阅)|(?:不要|无需|不必|禁止).{0,8}(?:修改|编辑|改写|替换|删除|插入|追加|写入|保存)/.test(normalized)) {
    return false
  }
  if (/(?:如何|怎么|建议|方案|讨论).{0,8}(?:修改|编辑|改写|替换|删除|插入|追加|写入|保存)/.test(normalized)) {
    return false
  }
  return /(?:修改|编辑|改写|重写|润色|替换|删除|删掉|移除|插入|追加|补充|更新|调整|排版|格式化|保存|写入|写到|做成|制作|生成|修复|修正)/.test(normalized)
}

export function buildExternalReadToolSnapshot(input: {
  resolved: ReadyToolTurnSnapshot
  authorizationId: string
  authorization: SkillToolAuthorization
  externalReadSlice: PreparedCodexExternalReadSlice
}): ReadyToolTurnSnapshot {
  return composeCodexTurnToolSnapshot({
    resolved: input.resolved,
    authorizationId: input.authorizationId,
    authorization: input.authorization,
    externalReadAllowedToolNames: input.externalReadSlice.allowedToolNames,
  })
}

export function buildExplicitResourceReadToolSnapshot(input: {
  resolved: ReadyToolTurnSnapshot
  authorizationId: string
  authorization: SkillToolAuthorization
  allowedResourceToolNames: readonly string[]
}): ReadyToolTurnSnapshot {
  return composeCodexTurnToolSnapshot({
    resolved: input.resolved,
    authorizationId: input.authorizationId,
    authorization: input.authorization,
    explicitResourceAllowedToolNames: input.allowedResourceToolNames,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validateCurrentDocumentReadPayload(input: {
  payload: Record<string, unknown>
  anchor: CodexCurrentDocumentAnchor
  requestBindingDigest: string
}): Record<string, unknown> {
  if (input.payload.ok === false) {
    if (input.payload.errorKind !== 'resource_version_superseded'
      || 'resourceRead' in input.payload) {
      throw new CodexToolBridgeError('resource_read_rejection_evidence_invalid')
    }
    return {
      ok: false,
      errorKind: 'resource_version_superseded',
      summary: '当前文档版本已经失效，请重新读取当前版本。',
      bodyBytes: 0,
      requestedVersion: input.anchor.currentVersion,
    }
  }
  const summary = typeof input.payload.summary === 'string' ? input.payload.summary : ''
  const modelVisibleSummary = summary.trim()
  const resourceRead = isRecord(input.payload.resourceRead) ? input.payload.resourceRead : null
  if (!modelVisibleSummary || !resourceRead
    || resourceRead.logicalResourceId !== input.anchor.logicalResourceId
    || resourceRead.currentVersion !== input.anchor.currentVersion
    || resourceRead.currentDigest !== input.anchor.currentDigest
    || resourceRead.policyEpoch !== input.anchor.policyEpoch
    || resourceRead.tabId !== input.anchor.tabId
    || resourceRead.pane !== input.anchor.pane
    || resourceRead.pathDigest !== input.anchor.pathDigest
    || resourceRead.incarnationKey !== input.anchor.incarnationKey
    || resourceRead.operation !== 'read_section'
    || resourceRead.requestBindingDigest !== input.requestBindingDigest
    || resourceRead.summaryDigest !== sha256(summary)
    || resourceRead.bodyBytes !== Buffer.byteLength(summary)) {
    throw new CodexToolBridgeError('resource_read_success_evidence_invalid')
  }
  return {
    ...input.payload,
    summary: modelVisibleSummary,
    resourceRead: {
      ...resourceRead,
      summaryDigest: sha256(modelVisibleSummary),
      bodyBytes: Buffer.byteLength(modelVisibleSummary),
    },
  }
}

export function createCurrentDocumentReadRequester(input: {
  anchor: CodexCurrentDocumentAnchor
  agent?: string
  sessionId: string
  scopeId: string
  readyRunId: string
  codexThreadId: string
  codexTurnId: string
  codexCallId: string
  readyActionId: string
  actionIdentityDigest: string
  resourceAnchorDigest: string
  abortSignal: AbortSignal
  requestRendererToolAction: CodexRendererToolActionRequester
  allowWrite?: boolean
  hasExactRead?: () => boolean
  onExactRead?: () => void
}): (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (tool, args) => {
    const readTool = tool === 'document.readSection'
    const readOnlyTools = new Set(['document.listWidgets'])
    const writeTools = new Set([
      'document.insertWidget',
      'document.updateWidget',
      'document.removeWidget',
      'document.replaceExact',
      'document.saveTab',
    ])
    if (!readTool && !readOnlyTools.has(tool) && !writeTools.has(tool)) {
      throw new CodexToolBridgeError('resource_tool_not_authorized')
    }
    if (writeTools.has(tool) && !input.allowWrite) {
      throw new CodexToolBridgeError('resource_tool_not_authorized')
    }
    if (writeTools.has(tool) && !input.hasExactRead?.()) {
      throw new CodexToolBridgeError('resource_write_requires_exact_read')
    }
    if (!readTool) {
      const nextArgs: Record<string, unknown> = { ...args, tabId: input.anchor.tabId }
      if (tool === 'document.saveTab') delete nextArgs.path
      return input.requestRendererToolAction({
        agent: input.agent,
        sessionId: input.sessionId,
        runId: input.readyRunId,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        codexCallId: input.codexCallId,
        readyActionId: input.readyActionId,
        actionIdentityDigest: input.actionIdentityDigest,
        tool,
        args: nextArgs,
        abortSignal: input.abortSignal,
      })
    }
    const requestBindingDigest = digestCanonicalJson({
      readyRunId: input.readyRunId,
      codexThreadId: input.codexThreadId,
      codexTurnId: input.codexTurnId,
      codexCallId: input.codexCallId,
      readyActionId: input.readyActionId,
      actionIdentityDigest: input.actionIdentityDigest,
      resourceAnchorDigest: input.resourceAnchorDigest,
    })
    const payload = validateCurrentDocumentReadPayload({
      payload: await input.requestRendererToolAction({
        agent: input.agent,
        sessionId: input.sessionId,
        runId: input.readyRunId,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.codexTurnId,
        codexCallId: input.codexCallId,
        readyActionId: input.readyActionId,
        actionIdentityDigest: input.actionIdentityDigest,
        tool,
        args: {
          ...args,
          tabId: input.anchor.tabId,
          maxChars: Math.min(
            input.anchor.readScope.maxChars,
            typeof args.maxChars === 'number' ? args.maxChars : input.anchor.readScope.maxChars,
          ),
          __readyResourceRead: {
            scopeId: input.scopeId,
            requestBindingDigest,
            anchor: input.anchor,
          },
        },
        abortSignal: input.abortSignal,
      }),
      anchor: input.anchor,
      requestBindingDigest,
    })
    if (payload.ok === false) return payload
    input.onExactRead?.()
    const resourceRead = payload.resourceRead as Record<string, unknown>
    const unsignedReceipt = {
      readyRunId: input.readyRunId,
      codexThreadId: input.codexThreadId,
      codexTurnId: input.codexTurnId,
      codexCallId: input.codexCallId,
      readyActionId: input.readyActionId,
      actionIdentityDigest: input.actionIdentityDigest,
      logicalResourceId: input.anchor.logicalResourceId,
      currentVersion: input.anchor.currentVersion,
      currentDigest: input.anchor.currentDigest,
      policyEpoch: input.anchor.policyEpoch,
      tabId: input.anchor.tabId,
      pane: input.anchor.pane,
      pathDigest: input.anchor.pathDigest,
      incarnationKey: input.anchor.incarnationKey,
      operation: 'read_section',
      summaryDigest: resourceRead.summaryDigest,
      bodyBytes: resourceRead.bodyBytes,
    }
    return {
      ...payload,
      resourceReadReceipt: {
        ...unsignedReceipt,
        receiptDigest: digestCanonicalJson(unsignedReceipt),
      },
    }
  }
}

export function toRunMessage(request: SendScopedRequest): RunMessage {
  return request.message as RunMessage
}

export function toCodexInput(request: SendScopedRequest): CodexUserInput[] | null {
  const result: CodexUserInput[] = []
  if (request.userMessage.content || (request.resources?.length ?? 0) > 0) {
    result.push({ type: 'text', text: request.userMessage.content, text_elements: [] })
  }
  if (Array.isArray(request.message)) {
    for (const block of request.message) {
      if (block.type === 'image') {
        result.push({ type: 'image', url: `data:${block.mimeType};base64,${block.base64}`, detail: null })
        continue
      }
      if (block.type === 'video') return null
    }
  }
  return result.length > 0 ? result : null
}

export class RuntimeGate implements CodexRuntimeIngressGate {
  private opened = false
  private reason = 'runtime_not_started'

  open(): void {
    this.opened = true
    this.reason = ''
  }

  close(reason: string): void {
    this.opened = false
    this.reason = reason || 'runtime_closed'
  }

  assertOpen(): void {
    if (!this.opened) throw new Error(this.reason || 'runtime_closed')
  }
}

export function readCodexInstructionContractDigest(
  assetRoot: string,
  developerInstructions: string = CODEX_HOST_OVERLAY,
): string {
  const fixture = JSON.parse(readFileSync(
    join(assetRoot, 'fixtures/native-protocol-capture.json'),
    'utf8',
  )) as { provider?: { requests?: Array<{ request?: { instructions?: unknown; input?: unknown } }> } }
  const request = fixture.provider?.requests?.[0]?.request
  if (!request) throw new Error('codex_instruction_fixture_missing')
  return instructionTranscriptDigest(request.instructions, [{
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: developerInstructions }],
  }])
}

export function resolveCodexBrowserWorkflowVerifierBundle(
  workflowInspection: BrowserWorkflowVerifierInspection,
): BrowserWorkflowVerifierBundle | null {
  if (workflowInspection.inspection.state === 'absent') return null
  if (workflowInspection.inspection.state !== 'sealable' || !workflowInspection.bundle) {
    throw new Error(`codex_browser_workflow_${workflowInspection.inspection.state}`)
  }
  return workflowInspection.bundle
}

export function codexAllowsDirectProvisionalStream(
  prepared: Pick<PreparedCodexProductRun, 'readyTurnToolAuthorization'>,
): boolean {
  return !prepared.readyTurnToolAuthorization.allowedToolNames
    .some(isBrowserPublicToolName)
}

export { buildCodexThreadDeveloperInstructions }

export function resolveCodexThreadInstructionContract(input: {
  assetRoot: string
  host: Pick<CodexRuntimeHostPort, 'resolveSelectedSkillMethodology'> | null
  skillAuthorization: { mode: 'none' } | { mode: 'selected'; skillId: string }
  expectedDigest?: string
}): { developerInstructions: string; instructionContractDigest: string } {
  void input.host
  const developerInstructions = buildCodexThreadDeveloperInstructions()
  const instructionContractDigest = readCodexInstructionContractDigest(
    input.assetRoot,
    developerInstructions,
  )
  if (input.expectedDigest && instructionContractDigest !== input.expectedDigest) {
    throw new Error('codex_recovered_instruction_contract_drift')
  }
  return { developerInstructions, instructionContractDigest }
}
