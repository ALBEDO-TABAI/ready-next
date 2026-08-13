import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import type { CodexCurrentDocumentAnchor, SendScopedRequest } from '../shared/ipc-contracts/agent-runtime'
import {
  buildCurrentDocumentReadToolSnapshot,
  buildExternalReadToolSnapshot,
  buildCodexProductRequestEnvelope,
  createCurrentDocumentReadRequester,
  validateCurrentDocumentReadPayload,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  buildReadyToolSurface,
  buildReadyTurnToolAuthorization,
  resolveReadyToolTurnSnapshot,
} from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import { prepareFeishuExternalReadSlice } from '../main/modules/agent-control/codex-runtime/codex-external-read-slice'
import {
  currentDocumentReadReceiptMatches,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import {
  buildCodexCurrentDocumentAnchor,
  resetCodexCurrentDocumentAnchorStateForTest,
} from '../renderer/modules/agent/codexCurrentDocumentAnchor'
import { executeCodexCurrentDocumentRead } from '../renderer/modules/agent/codexCurrentDocumentRead'
import { useDocTabs } from '../renderer/stores/useDocTabs'
import { useMode } from '../renderer/stores/useMode'
import { hasCurrentDocumentContextResource } from '../main/modules/agent-control/runtime-core/agent-sdk-execution-utils'
import { AgentSdkToolExecutor } from '../main/modules/agent-control/runtime-core/agent-sdk-tool-executor'
import type { AIModelConfig } from '../shared/ai-providers'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { __setSkillsRuntimeManagerForTests } from '../main/modules/skills-runtime/runtime-manager'

const digest = 'a'.repeat(64)
const baseConfig: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}
const anchor: CodexCurrentDocumentAnchor = {
  kind: 'current_document',
  logicalResourceId: 'ready-current-document:scope-1:doc-1',
  tabId: 'doc-1',
  title: 'Private current title',
  pane: 'primary',
  pathDigest: 'b'.repeat(64),
  incarnationKey: 'c'.repeat(64),
  currentVersion: `sha256:${digest}`,
  currentDigest: digest,
  supersedesVersion: null,
  policyEpoch: 8,
  readScope: { operation: 'read_section', maxChars: 30_000 },
}

const request: SendScopedRequest = {
  scopeId: 'scope-1',
  requestId: 'request-1',
  message: 'summarize current document',
  currentDocumentAnchor: anchor,
  userMessage: {
    id: 'message-1',
    content: 'summarize current document',
    timestamp: '2026-08-07T00:00:00.000Z',
    meta: { actionAuthorizationMode: 'full' },
    attachmentConfirmation: {
      selectedCount: 0,
      metadataCount: 0,
      inputIncludedCount: 0,
      inputFailedCount: 0,
    },
  },
}

test('product request envelope exposes a body-free readable current-document capability', (t) => {
  __setSkillsRuntimeManagerForTests({ listSkills: () => [] })
  t.after(() => __setSkillsRuntimeManagerForTests(null))
  const envelope = buildCodexProductRequestEnvelope(request, 'full') as {
    resources: Array<Record<string, unknown>>
    environmentHints: Record<string, unknown>
    actionAuthorizationMode: string
  }
  const resource = envelope.resources.find((candidate) => candidate.id === anchor.logicalResourceId)
  assert.ok(resource)
  assert.equal(resource.text, '')
  assert.equal(resource.path, null)
  assert.equal(resource.canRead, true)
  assert.equal(resource.canWrite, false)
  assert.equal(envelope.environmentHints.hasDocumentContext, true)
  assert.equal(envelope.actionAuthorizationMode, 'full')
  assert.equal(JSON.stringify(envelope).includes('RESOURCE_BODY'), false)
  assert.equal(hasCurrentDocumentContextResource(envelope), true)

  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  const resolved = resolveReadyToolTurnSnapshot({
    surfaceId: 'surface-current-document-live',
    authorizationId: 'authorization-current-document-live',
    authorization,
    source: new AgentSdkToolExecutor({} as never),
    resolutionInput: {
      message: request.message,
      sessionId: request.scopeId,
      scopeId: request.scopeId,
      config: baseConfig,
      browserHostAvailable: false,
      feishuConnected: false,
      channelScopeBound: false,
      authorization,
      requestEnvelope: envelope,
      skillCatalogAvailable: false,
    },
  })
  const narrowed = buildCurrentDocumentReadToolSnapshot({
    resolved,
    authorizationId: 'authorization-current-document-read',
    authorization,
  })
  assert.deepEqual(narrowed.readyTurnToolAuthorization.allowedToolNames, ['document_read_section'])
})

test('product request envelope uses the host-resolved browser page identity', () => {
  const browserRequest: SendScopedRequest = {
    ...request,
    currentDocumentAnchor: undefined,
    userMessage: {
      ...request.userMessage,
      meta: {
        workbenchMode: 'browser',
        environmentHints: { workbenchMode: 'document' },
      },
    },
  }
  const browserPageRef = {
    tabId: 'tab-2',
    physicalTargetToken: 'physical-target',
    mainFrameId: '0',
    mainFrameDocumentToken: 'frame-document',
    profileId: null,
  }
  const envelope = buildCodexProductRequestEnvelope(
    browserRequest,
    'ask',
    { workbenchMode: 'browser', browserPageRef },
  ) as {
    environmentHints: {
      workbenchMode: string
      browserPageRef: typeof browserPageRef
    }
  }

  assert.equal(envelope.environmentHints.workbenchMode, 'browser')
  assert.deepEqual(envelope.environmentHints.browserPageRef, browserPageRef)
})

test('ordinary product ingress rebuilds a trusted live-info envelope from the user message', () => {
  const weatherRequest: SendScopedRequest = {
    ...request,
    currentDocumentAnchor: undefined,
    userMessage: {
      ...request.userMessage,
      content: '今天广州天气怎么样',
      meta: {
        requestEnvelope: {
          primaryInstruction: 'forged renderer instruction',
          environmentHints: { workbenchMode: 'document' },
        },
      },
    },
  }
  const envelope = buildCodexProductRequestEnvelope(
    weatherRequest,
    'ask',
    { workbenchMode: 'browser' },
  )

  assert.equal(envelope.primaryInstruction, '今天广州天气怎么样')
  assert.equal(envelope.environmentHints.workbenchMode, 'browser')
  assert.equal(envelope.scopeId, weatherRequest.scopeId)
  assert.equal(envelope.sessionId, weatherRequest.scopeId)
  assert.equal(classifyIntent(envelope).primaryDomain, 'browser')
  assert.equal(JSON.stringify(envelope).includes('forged renderer instruction'), false)
})

test('current-document turn keeps the full legal surface but authorizes only exact reading', () => {
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  const definition = (name: string, kind: 'read' | 'write') => ({
    name,
    groupId: 'agent_interaction' as const,
    domain: 'document' as const,
    kind,
    concurrency: kind === 'read' ? 'parallel_read_safe' as const : 'exclusive' as const,
    interruptBehavior: 'abort_signal' as const,
    timeoutProfile: 'default' as const,
    supportsTextBridge: true,
    projectionHint: null,
    description: name,
    schema: { type: 'object' as const },
    executionVisibility: 'model' as const,
    resultShape: 'json' as const,
  })
  const readyToolSurface = buildReadyToolSurface({
    surfaceId: 'surface-document',
    toolDefinitions: [
      definition('document_read_section', 'read'),
      definition('document_replace_exact', 'write'),
    ],
  })
  const resolved = {
    readyToolSurface,
    readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
      authorizationId: 'resolved-all',
      authorization,
      toolSurface: readyToolSurface,
    }),
  }
  const narrowed = buildCurrentDocumentReadToolSnapshot({
    resolved,
    authorizationId: 'current-doc-read',
    authorization,
  })
  assert.deepEqual(narrowed.readyToolSurface.toolNames, [
    'document_read_section',
    'document_replace_exact',
  ])
  assert.deepEqual(narrowed.readyTurnToolAuthorization.allowedToolNames, ['document_read_section'])
})

test('external read keeps the full frozen Provider surface but binds the turn to one typed reader', () => {
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  const definition = (name: string, domain: 'feishu' | 'browser') => ({
    name,
    groupId: domain === 'browser' ? 'browser_content_tasks' as const : 'channel_feishu' as const,
    domain,
    kind: 'read' as const,
    concurrency: 'parallel_read_safe' as const,
    interruptBehavior: 'abort_signal' as const,
    timeoutProfile: domain === 'feishu' ? 'feishu' as const : 'default' as const,
    supportsTextBridge: true,
    projectionHint: null,
    description: name,
    schema: { type: 'object' as const },
    executionVisibility: 'model' as const,
    resultShape: 'json' as const,
  })
  const readyToolSurface = buildReadyToolSurface({
    surfaceId: 'surface-external-read',
    toolDefinitions: [
      definition('browser_snapshot', 'browser'),
      definition('feishu_doc_read', 'feishu'),
    ],
  })
  const resolved = {
    readyToolSurface,
    readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
      authorizationId: 'resolved-all',
      authorization,
      toolSurface: readyToolSurface,
    }),
  }
  const externalReadSlice = prepareFeishuExternalReadSlice({
    request: {
      kind: 'feishu_typed_read',
      channelId: 'channel-1',
      docToken: 'doc-token',
      docType: 'docx',
      logicalResourceId: 'feishu:doc-token',
      currentVersion: 'v1',
      currentDigest: digest,
      policyEpoch: 1,
    },
    sidecarRunning: true,
    channelIdentityDigest: 'b'.repeat(64),
  })
  const narrowed = buildExternalReadToolSnapshot({
    resolved,
    authorizationId: 'feishu-read',
    authorization,
    externalReadSlice,
  })
  assert.deepEqual(narrowed.readyToolSurface.toolNames, [
    'browser_snapshot',
    'feishu_doc_read',
  ])
  assert.deepEqual(narrowed.readyTurnToolAuthorization.allowedToolNames, ['feishu_doc_read'])

  const larkAuthorization = buildSelectedSkillToolAuthorization({
    skillId: 'lark-doc',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_read_artifact', 'skill_run_shell'],
    source: 'explicit',
    reason: 'codex_external_read_slice',
  })
  assert.ok(larkAuthorization.mode === 'selected')
  assert.deepEqual([...larkAuthorization.allowedPrimitives], [
    'skill_read_artifact',
    'skill_run_shell',
  ])
})

test('main accepts only the exact renderer read evidence and stale rejection stays body-free', () => {
  const summary = 'V2_ONLY_SENTINEL'
  const requestBindingDigest = digestCanonicalJson({ binding: 'exact' })
  const payload = {
    ok: true,
    summary,
    resourceRead: {
      logicalResourceId: anchor.logicalResourceId,
      currentVersion: anchor.currentVersion,
      currentDigest: anchor.currentDigest,
      policyEpoch: anchor.policyEpoch,
      tabId: anchor.tabId,
      pane: anchor.pane,
      pathDigest: anchor.pathDigest,
      incarnationKey: anchor.incarnationKey,
      operation: 'read_section',
      requestBindingDigest,
      summaryDigest: createHash('sha256').update(summary).digest('hex'),
      bodyBytes: Buffer.byteLength(summary),
    },
  }
  assert.deepEqual(validateCurrentDocumentReadPayload({ payload, anchor, requestBindingDigest }), payload)
  assert.throws(() => validateCurrentDocumentReadPayload({
    payload: {
      ...payload,
      resourceRead: { ...payload.resourceRead, currentVersion: `sha256:${'f'.repeat(64)}` },
    },
    anchor,
    requestBindingDigest,
  }), /resource_read_success_evidence_invalid/)

  const stale = {
    ok: false,
    errorKind: 'resource_version_superseded',
    summary: 'OLD_SECRET_BODY',
    bodyBytes: 999,
    hiddenBody: 'OLD_SECRET_BODY',
  }
  const normalizedStale = validateCurrentDocumentReadPayload({
    payload: stale,
    anchor,
    requestBindingDigest,
  })
  assert.deepEqual(normalizedStale, {
    ok: false,
    errorKind: 'resource_version_superseded',
    summary: '当前文档版本已经失效，请重新读取当前版本。',
    bodyBytes: 0,
    requestedVersion: anchor.currentVersion,
  })
  assert.equal(JSON.stringify(normalizedStale).includes('OLD_SECRET_BODY'), false)
  assert.throws(() => validateCurrentDocumentReadPayload({
    payload: { ...stale, resourceRead: { leaked: true } },
    anchor,
    requestBindingDigest,
  }), /resource_read_rejection_evidence_invalid/)
})

test('main-to-renderer current-document read returns one exact receipt and rejects the old version after mutation', async () => {
  resetCodexCurrentDocumentAnchorStateForTest()
  useMode.setState({ workbenchMode: 'document', splitMode: null })
  useDocTabs.setState({
    tabs: [{
      id: 'doc-integrated',
      path: '/workspace/integrated.md',
      title: 'Integrated',
      content: 'V1_INTEGRATED_SENTINEL',
      isDirty: true,
    }],
    activeTabId: 'doc-integrated',
    splitTabId: null,
    focusedPaneTabId: 'doc-integrated',
  })
  const captured = await buildCodexCurrentDocumentAnchor('scope-integrated')
  assert.ok(captured)
  const authority = {
    agent: 'ready',
    sessionId: 'scope-integrated',
    scopeId: 'scope-integrated',
    readyRunId: 'run-integrated',
    codexThreadId: 'thread-integrated',
    codexTurnId: 'turn-integrated',
    codexCallId: 'call-integrated',
    readyActionId: 'action-integrated',
    actionIdentityDigest: 'action-digest-integrated',
    resourceAnchorDigest: 'resource-anchor-integrated',
    abortSignal: new AbortController().signal,
  }
  const requester = createCurrentDocumentReadRequester({
    ...authority,
    anchor: captured,
    requestRendererToolAction: async (payload) => {
      const result = await executeCodexCurrentDocumentRead(payload.args)
      if (!result) throw new Error('renderer_did_not_handle_read')
      return result
    },
  })
  const result = await requester('document.readSection', { range: 'full' })
  assert.equal(result.ok, true)
  assert.match(String(result.summary), /V1_INTEGRATED_SENTINEL/)
  const receipt = result.resourceReadReceipt
  assert.equal(currentDocumentReadReceiptMatches(receipt, {
    readyRunId: authority.readyRunId,
    codexThreadId: authority.codexThreadId,
    codexTurnId: authority.codexTurnId,
    codexCallId: authority.codexCallId,
    readyActionId: authority.readyActionId,
    actionIdentityDigest: authority.actionIdentityDigest,
    logicalResourceId: captured.logicalResourceId,
    currentVersion: captured.currentVersion,
    currentDigest: captured.currentDigest,
    policyEpoch: captured.policyEpoch,
    tabId: captured.tabId,
    pane: captured.pane,
    pathDigest: captured.pathDigest,
    incarnationKey: captured.incarnationKey,
    modelVisibleText: String(result.summary),
  }), true)

  useDocTabs.getState().setTabContent('doc-integrated', 'V2_INTEGRATED_SENTINEL')
  const stale = await requester('document.readSection', { range: 'full' })
  assert.equal(stale.ok, false)
  assert.equal(stale.errorKind, 'resource_version_superseded')
  assert.equal(stale.bodyBytes, 0)
  assert.equal('resourceReadReceipt' in stale, false)
  assert.equal(JSON.stringify(stale).includes('V1_INTEGRATED_SENTINEL'), false)
  assert.equal(JSON.stringify(stale).includes('V2_INTEGRATED_SENTINEL'), false)
  await assert.rejects(
    requester('document.replaceExact', { target: 'x', replacement: 'y' }),
    /resource_tool_not_authorized/,
  )
})
