import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import type { CodexCurrentDocumentAnchor, SendScopedRequest } from '../shared/ipc-contracts/agent-runtime'
import {
  buildCurrentDocumentReadToolSnapshot,
  buildExternalReadToolSnapshot,
  buildCodexProductRequestEnvelope,
  createCurrentDocumentReadRequester,
  hasExplicitCurrentDocumentAccessExclusion,
  hasExplicitCurrentDocumentAccessIntent,
  hasExplicitCurrentDocumentWriteProhibition,
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
import { resolveCurrentDocumentActivation } from '../main/modules/agent-control/codex-runtime/codex-product-turn-authorization'
import { DOCUMENT_WRITE_FLOOR_TOOL_NAMES } from '../main/modules/agent-control/codex-runtime/codex-product-action-map'
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
import { executeModuleToolAction } from '../renderer/modules/agent/moduleExecutor'
import { extractProductSurfaceTargets } from '../main/modules/agent-control/codex-runtime/codex-product-surface-ingress'

test('empty resource selections do not create a structured product target', () => {
  assert.equal(extractProductSurfaceTargets([]), undefined)
})

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
  assert.ok(narrowed.readyTurnToolAuthorization.allowedToolNames.includes('document_read_section'))
  assert.equal(narrowed.readyTurnToolAuthorization.allowedToolNames.includes('document_insert_widget'), false)
  assert.equal(narrowed.readyTurnToolAuthorization.allowedToolNames.includes('document_save_tab'), false)
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
  assert.equal(classifyIntent(envelope).primaryDomain, 'research')
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
  assert.ok(narrowed.readyTurnToolAuthorization.allowedToolNames.includes('document_read_section'))
  assert.equal(narrowed.readyTurnToolAuthorization.allowedToolNames.includes('document_insert_widget'), false)
  assert.equal(narrowed.readyTurnToolAuthorization.allowedToolNames.includes('document_save_tab'), false)
})

// 2026-10-06: guessing write intent from wording kept missing requests ("换成", "做一些信息卡"); a pointed-at
// document is now writable and only an explicit read-only request keeps it read-only.
test('only an explicit read-only request keeps the current document read-only', () => {
  for (const text of [
    '只阅读当前文档并总结',
    '不要修改，只检查是否有错字',
    '别改动原文，帮我看看结构',
    '仅查看这篇文档的结论',
  ]) assert.equal(hasExplicitCurrentDocumentWriteProhibition(text), true, text)
  for (const text of [
    '把文档中这些引用块卡片换成 Ready 信息卡',
    '试着在文档中做一些信息卡来让内容更加可读',
    '这篇文档还能怎么改进？',
    '只需把第二段改短',
  ]) assert.equal(hasExplicitCurrentDocumentWriteProhibition(text), false, text)
})

test('only explicit current-document intent activates an ambient current document', () => {
  assert.equal(
    hasExplicitCurrentDocumentAccessExclusion('不使用任何 skill，不查看任何的本地文档，只在线检索并输出到目标文件夹'),
    true,
  )
  assert.equal(hasExplicitCurrentDocumentAccessExclusion('不要读取当前文档，只查公开网页'), true)
  assert.equal(hasExplicitCurrentDocumentAccessExclusion('只阅读当前文档并总结'), false)
  assert.equal(hasExplicitCurrentDocumentAccessExclusion('不查看其他文档，只总结当前文档'), false)
  assert.equal(hasExplicitCurrentDocumentAccessIntent('只阅读当前文档并总结'), true)
  assert.equal(hasExplicitCurrentDocumentAccessIntent('帮我润色这篇文档'), true)
  assert.equal(hasExplicitCurrentDocumentAccessIntent('review this document'), true)
  assert.equal(hasExplicitCurrentDocumentAccessIntent('只盘点所附文件夹，不要写文件'), false)
  assert.equal(hasExplicitCurrentDocumentAccessIntent('在线查资料，整理为一份文档输出'), false)
  assert.equal(hasExplicitCurrentDocumentAccessIntent('试着在文档中做一些信息卡来让内容更加可读'), true)
  assert.equal(hasExplicitCurrentDocumentAccessIntent('往笔记里补一段总结'), true)
  assert.equal(hasExplicitCurrentDocumentAccessIntent('把文档中这些引用块卡片换成 Ready 信息卡'), true)
  assert.equal(hasExplicitCurrentDocumentAccessIntent('不要读取当前文档，只查公开网页'), false)

  const envelope = buildCodexProductRequestEnvelope(
    request,
    'full',
    {},
    [],
    false,
    false,
  )
  assert.equal(
    envelope.resources.some((resource) => resource.kind === 'document_context'),
    false,
  )
  assert.equal(envelope.environmentHints.hasDocumentContext, false)
})

test('current-document write turn requires exact read, pins every mutation to the anchored tab and forbids save-as', async () => {
  let exactRead = false
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const requester = createCurrentDocumentReadRequester({
    anchor,
    agent: 'ready',
    sessionId: 'scope-1',
    scopeId: 'scope-1',
    readyRunId: 'run-write',
    codexThreadId: 'thread-write',
    codexTurnId: 'turn-write',
    codexCallId: 'call-write',
    readyActionId: 'action-write',
    actionIdentityDigest: 'action-write-digest',
    resourceAnchorDigest: 'resource-write-digest',
    abortSignal: new AbortController().signal,
    allowWrite: true,
    hasExactRead: () => exactRead,
    onExactRead: () => { exactRead = true },
    requestRendererToolAction: async (payload) => {
      calls.push({ tool: payload.tool, args: payload.args })
      if (payload.tool !== 'document.readSection') return { ok: true, mutated: true }
      const summary = 'anchored document body'
      const requestBindingDigest = (payload.args.__readyResourceRead as { requestBindingDigest: string }).requestBindingDigest
      return {
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
    },
  })

  await assert.rejects(
    requester('document.replaceExact', { tabId: 'other-tab', target: 'old', replacement: 'new' }),
    /resource_write_requires_exact_read/,
  )
  await requester('document.readSection', { tabId: 'other-tab', range: 'full' })
  await requester('document.replaceExact', { tabId: 'other-tab', target: 'old', replacement: 'new' })
  await requester('document.saveTab', { tabId: 'other-tab', path: '/tmp/escaped.md' })

  assert.equal(calls[0]?.args.tabId, anchor.tabId)
  assert.deepEqual(calls[1], {
    tool: 'document.replaceExact',
    args: {
      tabId: anchor.tabId, target: 'old', replacement: 'new',
      __readyResourceWrite: { scopeId: 'scope-1', anchor },
    },
  })
  assert.deepEqual(calls[2], {
    tool: 'document.saveTab',
    args: { tabId: anchor.tabId, __readyResourceWrite: { scopeId: 'scope-1', anchor } },
  })
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
  assert.ok(narrowed.readyTurnToolAuthorization.allowedToolNames.includes('feishu_doc_read'))
  assert.ok(narrowed.readyTurnToolAuthorization.allowedToolNames.includes('browser_snapshot'))

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

// 2026-10-06: the user had the reading review open, attached its tab and asked "试着在文档中做一些信息卡…"; Main
// dropped the anchor, the file arrived as a read-only copy, and the cards were faked with Markdown quotes.
test('the open document attached to the message is the current document, and asking for cards opens the card tools', async () => {
  resetCodexCurrentDocumentAnchorStateForTest()
  const path = '/Users/reader/卡拉马佐夫兄弟/阅读回顾·第一卷至第四卷第二章.md'
  useMode.setState({ workbenchMode: 'document', splitMode: null })
  useDocTabs.setState({
    tabs: [{ id: 'doc-review', path, title: '阅读回顾·第一卷至第四卷第二章.md', content: '# 阅读回顾\n', isDirty: false }],
    activeTabId: 'doc-review',
    splitTabId: null,
    focusedPaneTabId: 'doc-review',
  })
  const anchor = await buildCodexCurrentDocumentAnchor('scope-cards')
  assert.ok(anchor)
  const chip = {
    kind: 'local_file' as const, id: 'chip-review', name: '阅读回顾·第一卷至第四卷第二章.md', path,
    size: 12, ext: 'md', rendererType: 'text' as const,
  }
  const otherFile = { ...chip, id: 'chip-other', name: '其他.md', path: '/Users/reader/其他.md' }

  const activate = (resources: Array<typeof chip>, intentText: string, overrides: { ambient?: boolean; anchor?: null } = {}) => (
    resolveCurrentDocumentActivation({
      resources, anchor: overrides.anchor === null ? null : anchor, intentText, ambient: overrides.ambient ?? true,
    })
  )
  const cards = activate([chip, otherFile], '试着在文档中做一些信息卡来让内容更加可读')
  assert.deepEqual([cards.anchor, cards.canWrite, cards.readRequired], [anchor, true, true])
  assert.deepEqual([...cards.documentFileIds], ['chip-review'], 'only the open document stands in for its file')
  const attachedOnly = activate([chip], '让内容更好读一点')
  assert.deepEqual([attachedOnly.anchor, attachedOnly.readRequired], [anchor, true], 'attaching it points at it')
  const readOnly = activate([chip], '只阅读这篇文档并总结')
  assert.deepEqual([readOnly.anchor, readOnly.canWrite], [anchor, false], 'an explicit read-only request stays read-only')

  // 2026-10-06: a follow-up in the same conversation ("把第二节也换成信息卡", "继续") names no document; the agent knows
  // what it refers to, so the focused document stays available without a forced read (unrelated replies are not blocked).
  for (const text of ['把第二节也换成信息卡', '继续', '今天天气怎么样']) {
    const followUp = activate([], text)
    assert.deepEqual([followUp.anchor, followUp.canWrite, followUp.readRequired], [anchor, true, false], text)
  }
  assert.equal(activate([], '把第二节也换成信息卡', { ambient: false }).anchor, null, 'an explicit Retry takes no document it was not given')
  for (const inactive of [
    activate([chip], '不要读取当前文档，只查公开网页'),
    activate([], '继续', { anchor: null }),
  ]) {
    assert.deepEqual([inactive.anchor, inactive.canWrite, inactive.documentFileIds.size], [null, false, 0])
  }

  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  const definition = (name: string, kind: 'read' | 'write') => ({
    name, groupId: 'agent_interaction' as const, domain: 'document' as const, kind,
    concurrency: kind === 'read' ? 'parallel_read_safe' as const : 'exclusive' as const,
    interruptBehavior: 'abort_signal' as const, timeoutProfile: 'default' as const, supportsTextBridge: true,
    projectionHint: null, description: name, schema: { type: 'object' as const }, executionVisibility: 'model' as const,
    resultShape: 'json' as const,
  })
  const readyToolSurface = buildReadyToolSurface({
    surfaceId: 'surface-cards',
    toolDefinitions: [
      definition('document_read_section', 'read'),
      ...DOCUMENT_WRITE_FLOOR_TOOL_NAMES.map((name) => definition(name, 'write')),
    ],
  })
  const snapshot = buildCurrentDocumentReadToolSnapshot({
    resolved: {
      readyToolSurface,
      readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
        authorizationId: 'resolved-cards', authorization, toolSurface: readyToolSurface,
      }),
    },
    authorizationId: 'current-doc-cards',
    authorization,
    allowWrite: cards.canWrite,
  })
  for (const name of ['document_read_section', 'document_insert_widget', 'document_save_tab']) {
    assert.ok(snapshot.readyTurnToolAuthorization.allowedToolNames.includes(name), name)
  }

  // A thread frozen before the edit tools existed keeps working, read-only, instead of being rejected.
  const readOnlySurface = buildReadyToolSurface({ surfaceId: 'surface-read-only', toolDefinitions: [definition('document_read_section', 'read')] })
  const olderThread = buildCurrentDocumentReadToolSnapshot({
    resolved: {
      readyToolSurface: readOnlySurface,
      readyTurnToolAuthorization: buildReadyTurnToolAuthorization({
        authorizationId: 'resolved-read-only', authorization, toolSurface: readOnlySurface,
      }),
    },
    authorizationId: 'current-doc-read-only',
    authorization,
    allowWrite: true,
  })
  assert.deepEqual(olderThread.readyTurnToolAuthorization.allowedToolNames, ['document_read_section'])
})

test('current-document write authorization reaches the anchored renderer tab and saves only its existing path', async () => {
  resetCodexCurrentDocumentAnchorStateForTest()
  useMode.setState({ workbenchMode: 'document', splitMode: null })
  useDocTabs.setState({
    tabs: [{
      id: 'doc-write-integrated',
      path: '/tmp/codex-current-write.md',
      title: 'codex-current-write.md',
      content: '# 标题\n\n旧句\n',
      isDirty: false,
    }],
    activeTabId: 'doc-write-integrated',
    splitTabId: null,
    focusedPaneTabId: 'doc-write-integrated',
  })
  const captured = await buildCodexCurrentDocumentAnchor('scope-write-integrated')
  assert.ok(captured)
  let exactRead = false
  const writes: Array<{ path: string; content: string }> = []
  const priorWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        document: {
          readFile: async () => ({ success: true, content: '# 标题\n\n旧句\n' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
      localStorage: { getItem: () => null },
    },
  })
  try {
    const requester = createCurrentDocumentReadRequester({
      anchor: captured,
      agent: 'ready',
      sessionId: 'scope-write-integrated',
      scopeId: 'scope-write-integrated',
      readyRunId: 'run-write-integrated',
      codexThreadId: 'thread-write-integrated',
      codexTurnId: 'turn-write-integrated',
      codexCallId: 'call-write-integrated',
      readyActionId: 'action-write-integrated',
      actionIdentityDigest: 'action-write-integrated-digest',
      resourceAnchorDigest: 'resource-write-integrated-digest',
      abortSignal: new AbortController().signal,
      allowWrite: true,
      hasExactRead: () => exactRead,
      onExactRead: () => { exactRead = true },
      requestRendererToolAction: async (payload) => {
        const result = await executeModuleToolAction({
          scopeId: payload.scopeId,
          agentName: payload.agent || 'ready',
          tool: payload.tool,
          args: payload.args,
          runId: payload.runId,
          activateWorkbenchMode: () => {},
          upsertScopeRunState: () => {},
        })
        if (!result.handled || !result.payload) throw new Error('renderer_did_not_handle_document_action')
        return result.payload
      },
    })

    await requester('document.readSection', { range: 'full' })
    await requester('document.replaceExact', {
      tabId: 'other-tab',
      target: '旧句',
      replacement: '新句',
    })
    // 2026-10-06: after the turn's own first edit every later read came back superseded, so the rest of a long
    // document could no longer be read in that turn.
    const afterOwnEdit = await requester('document.readSection', { range: 'full' })
    assert.equal(afterOwnEdit.ok, true, 'a version produced by the turn itself stays readable')
    assert.match(String(afterOwnEdit.summary), /新句/)
    await requester('document.saveTab', {
      tabId: 'other-tab',
      path: '/tmp/escaped.md',
    })

    assert.deepEqual(writes, [{
      path: '/tmp/codex-current-write.md',
      content: '# 标题\n\n新句\n',
    }])
    const saved = useDocTabs.getState().tabs.find((tab) => tab.id === 'doc-write-integrated')
    assert.equal(saved?.path, '/tmp/codex-current-write.md')
    assert.equal(saved?.content, '# 标题\n\n新句\n')
    assert.equal(saved?.isDirty, false)
    useDocTabs.getState().setTabContent('doc-write-integrated', '# 标题\n\n用户自己改的\n')
    const afterUserEdit = await requester('document.readSection', { range: 'full' })
    assert.equal(afterUserEdit.errorKind, 'resource_version_superseded', 'an edit the turn did not make is not authorized')
  } finally {
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow })
  }
})
