import { parseSendScopedRequest } from '../shared/ipc-contracts/agent-runtime'
import { validateExplicitRetryControl } from '../main/modules/agent-control/codex-runtime/codex-explicit-retry-control'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import type { ProductTurnReceipt, SendScopedRequest } from '../shared/ipc-contracts/agent-runtime'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import { useAgent } from '../renderer/stores/useAgent'
import { useDocTabs } from '../renderer/stores/useDocTabs'
import { useMode } from '../renderer/stores/useMode'
import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'
import { productTurnActionProjectionMatchesContext } from '../renderer/modules/agent/productTurnReceipt'
import type { AgentMessage, ConversationScope } from '../renderer/modules/agent/types'
import { makeProductTurnActionProjection } from './product-turn-action-projection-fixture'

// Renderer handoff regression, not Main admission or installed-app proof. The document
// store is left at its real default; only a completed failed run and Main IPC are seeded.
// Raw observations must reach Main, which alone resolves whether the original task activates them.
export const __breaksInvariants = [
  'renderer.agent-store.singleton-seeded-with-completed-failed-run',
  'renderer.mode-store-selected-document-without-mutating-default-doc-tabs',
  'renderer.electron-api-replaced-at-main-ipc-boundary',
] as const

const scopeId = 'scope-default-document-retry'
const sessionId = 'session-default-document-retry'
const runId = 'run-failed-C'
const timestamp = '2026-09-03T00:00:00.000Z'

function installFailedRun(t: TestContext, mode: 'browser' | 'document' = 'document') {
  const previousAgent = useAgent.getState()
  const previousMode = useMode.getState()
  const previousWindow = globalThis.window
  const defaultDocument = useDocTabs.getState()
  assert.equal(defaultDocument.tabs.length, 1, 'do not replace the real default document with tabs=[]')
  assert.equal(defaultDocument.tabs[0].path, null)
  assert.equal(defaultDocument.tabs[0].content, '')
  assert.equal(defaultDocument.activeTabId, defaultDocument.tabs[0].id)

  const head = projectCodexHeadActionProjection({
    scopeId, scopeEpoch: 0, aliasId: scopeId, aliasGeneration: 2,
    threadBindingId: 'binding-successor', headRevision: 2, actionProjectionSequence: 2,
    materializationKind: 'native_fork', materializationState: 'confirmed',
    codexThreadId: 'native-successor', continuationBlocked: false, activeProductFence: false,
    manualCompactionState: 'none', hasLegacyPreparedRun: false,
    headRuntimeManifestDigest: 'runtime', headProtocolSchemaDigest: 'protocol',
    currentRuntimeManifestDigest: 'runtime', currentProtocolSchemaDigest: 'protocol',
  })
  const action = makeProductTurnActionProjection({ readyRunId: runId, retryAvailability: 'ready' })
  assert.equal(action.retryEvidenceKind, 'complete')
  if (action.retryEvidenceKind !== 'complete') throw new Error('complete_retry_fixture_required')
  const actionProjection = {
    ...action,
    headProjectionRef: { version: head.actionProjectionVersion, digest: head.evidenceDigest },
    currentTrustedEnvironmentRef: {
      ...action.currentTrustedEnvironmentRef,
      requestedWorkbenchMode: mode, trustedWorkbenchMode: mode,
    },
    productTurnActionProjectionVersion: {
      ...action.productTurnActionProjectionVersion, headProjectionVersion: head.actionProjectionVersion,
    },
  }
  const message: AgentMessage = {
    id: 'assistant-failed-C', type: 'agent', agent: 'butler', content: '本轮未能完成。',
    timestamp: new Date(timestamp), meta: { runId, terminalReason: 'blocked_external' },
  }
  const receipt: ProductTurnReceipt = {
    contract: 'ready_product_turn_receipt_v3', readyRunId: runId, readyTaskId: 'task-C',
    readyScopeId: scopeId, messageVisibilityEpoch: 0, ownerAliasGeneration: 1,
    revision: 1, terminal: 'error', actionProjection,
    canonicalMessage: {
      id: message.id, conversationId: scopeId, role: 'assistant', content: message.content,
      timestamp, meta: message.meta,
    },
    canonicalMessageDigest: 'a'.repeat(64), presentationDigest: 'b'.repeat(64),
    tools: [], artifacts: [], memory: null, publicationSealDigest: null,
    failure: { kind: 'transport', effectState: 'none', evidenceRefs: [] },
  }
  const scope: ConversationScope = {
    id: scopeId, aliasGeneration: 2, messageVisibilityEpoch: 0, agent: 'butler',
    activeAgentId: 'butler', handoffGeneration: 0, title: 'Default document Retry',
    sourceKind: 'local', sourceId: 'app', threadKey: scopeId, meta: {},
    createdAt: timestamp, updatedAt: timestamp, lastMessageAt: null,
  }
  const slice = {
    ...makeEmptySessionSlice(scopeId), aliasGeneration: 2, messages: [message],
    scopeHeadActionProjection: head, productTurnActionProjectionByRunId: { [runId]: actionProjection },
  }
  useAgent.setState({
    ...slice, currentAgent: 'butler', currentScopeId: scopeId, currentScope: scope,
    scopes: [scope], conversations: [], attachments: [], filePool: [], scopeLiveMessages: {},
    pendingContinuationIntent: null, pendingContinuationDraftAnchor: null, retiredScopeIds: {},
    sessions: { [sessionId]: slice }, activeSessionId: sessionId, sessionId, sessionOrder: [sessionId],
  })
  useMode.setState({ workbenchMode: mode, splitMode: mode === 'browser' ? 'document' : null })
  assert.equal(productTurnActionProjectionMatchesContext(actionProjection, head, mode), true)
  assert.equal(head.actions.send_new_message.availability, 'ready')

  const sent: SendScopedRequest[] = []
  const presentationReads: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { agent: {
      readProductTurnPresentation: async (readyRunId: string) => {
        presentationReads.push(readyRunId)
        return { success: true, data: receipt }
      },
      sendScoped: async (payload: SendScopedRequest) => {
        const transported = parseSendScopedRequest(payload)
        if (payload.explicitRetry) assert.deepEqual(validateExplicitRetryControl({
          request: transported,
          scope: { id: scopeId, source_kind: 'local', source_id: 'app', thread_key: scopeId, meta_json: '{}' },
        }).ok, true, 'the actual Renderer envelope must pass the Main control validator')
        sent.push(payload)
        // Stop at the IPC boundary: no fabricated admission, persistence or Provider success.
        return { success: false, disposition: 'rejected_before_persistence', errorKind: 'thread_busy' }
      },
    } } },
  })
  t.after(() => {
    Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
    useAgent.setState(previousAgent, true)
    useMode.setState(previousMode, true)
  })
  return { sent, presentationReads, receipt }
}

test('natural Retry preserves the exact failed owner with the real default document open', async (t) => {
  const { sent, presentationReads, receipt } = installFailedRun(t)
  await useAgent.getState().sendMessage('再试一次')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].currentDocumentAnchor, 'Main receives the current raw observation')
  assert.deepEqual(sent[0].explicitRetry, {
    predecessorRunId: runId, predecessorPresentationDigest: receipt.presentationDigest,
  }, 'a ready Retry must not silently become ordinary input because the default document exists')
  assert.deepEqual(presentationReads, [runId])
})

test('Retry button handoff reaches Main with the real default document open', async (t) => {
  const { sent, receipt } = installFailedRun(t)
  const explicitRetry = { predecessorRunId: runId, predecessorPresentationDigest: receipt.presentationDigest }
  // Exact public send arguments used by ChatPanel after its current receipt read.
  const result = await useAgent.getState().sendMessage('再试一次', { explicitRetry })
  assert.equal(sent.length, 1, `ready Retry was rejected before Main: ${result.errorKind}`)
  assert.deepEqual(sent[0].explicitRetry, explicitRetry)
})


test('browser mode with a document split preserves the same Retry handoff', async (t) => {
  const { sent, receipt } = installFailedRun(t, 'browser')
  await useAgent.getState().sendMessage('再试一次')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].currentDocumentAnchor)
  assert.deepEqual(sent[0].explicitRetry, { predecessorRunId: runId, predecessorPresentationDigest: receipt.presentationDigest })
})

test('continue in the default document is ordinary input, never the previous task root', async (t) => {
  const { sent, presentationReads } = installFailedRun(t)
  await useAgent.getState().sendMessage('继续')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].explicitRetry, undefined)
  assert.equal(sent[0].userMessage.content, '继续')
  assert.deepEqual(presentationReads, [])
})


test('natural Retry with a newly attached resource refuses before IPC and preserves the draft', async (t) => {
  const { sent } = installFailedRun(t)
  const attachments = [{ id: 'new-file', name: 'new.txt', path: '/tmp/new.txt', type: 'text' as const,
    size: 1, ext: '.txt', source: 'file' as const }]
  useAgent.getState().addAttachments(attachments)
  useAgent.getState().setInputValue('再试一次')
  const result = await useAgent.getState().sendMessage('再试一次')
  assert.equal(result.errorKind, 'explicit_retry_control_invalid')
  assert.equal(sent.length, 0)
  assert.deepEqual(useAgent.getState().attachments, attachments)
  assert.equal(useAgent.getState().inputValue, '再试一次')
})
