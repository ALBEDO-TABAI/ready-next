import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start)
  const endIndex = value.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return value.slice(startIndex, endIndex)
}

test('production AgentControlRuntime assembles only the Codex coordinator branch', () => {
  const runtime = source('src/main/modules/agent-control/runtime-core/runtime.ts')
  assert.match(runtime, /new CodexHostOrchestrator\(/)
  assert.doesNotMatch(runtime, /from ['"]\.\/orchestrator['"]/)
  assert.doesNotMatch(runtime, /from ['"]\.\/agent-sdk-runtime['"]/)
  assert.doesNotMatch(runtime, /\bAgentSdkRuntime\b|\bAgentSdkTurnOrchestrator\b/)

  const assembly = between(runtime, 'this.runCoordinator = new RunCoordinator({', 'this.runProjection =')
  assert.doesNotMatch(assembly, /CodexProductRunPreparer|codexProductRunPreparer|\.prepare\(/)
  assert.match(
    assembly,
    /this\.codexRuntime\.lifecycleAdapter\.executePreparedRun\(\{[\s\S]*?emitStartedProjection:\s*input\.emitStartedProjection,[\s\S]*?resolveContext:\s*\(\)\s*=>\s*this\.codexRuntime\.preparedRunContextPort\.resolve\(input\)/,
  )
  assert.doesNotMatch(assembly, /preparedRunPort/)
  assert.doesNotMatch(assembly, /runtimeKernel|ready-agent-sdk-retired/)
  assert.doesNotMatch(assembly, /codex_ingress_dispatch_unavailable/)
  for (const retired of [
    'promptAssembly:',
    'executeAndCollect:',
    'resolveExecutionProfile:',
    'createExecutionBinding:',
    'getPendingHandoff:',
  ]) {
    assert.equal(assembly.includes(retired), false, retired)
  }
})

test('Codex send ingress has no old prompt, workflow, delivery, or session-cap path', () => {
  const runtime = source('src/main/modules/agent-control/runtime-core/runtime.ts')
  const send = between(runtime, 'async sendScoped(payload: SendScopedRequest)', 'private async finalizeStaleWithoutHandleProjectionsForScope')
  assert.match(send, /runConfirmedSendScoped\(/)
  assert.match(send, /startIdentityPort\.reserve/)
  assert.match(send, /emitIngressAdmitted/)
  assert.match(send, /ingressPort\.prepareIngress/)
  assert.match(send, /ingressPort\.persistIngressAtomic/)
  assert.match(send, /prepared:\s*dispatchContext/)
  assert.match(send, /this\.runCoordinator\.runScoped/)
  assert.doesNotMatch(send, /codex_ingress_repository_unavailable|codex_ingress_dispatch_unavailable/)
  for (const retired of [
    'promptAssembly',
    'deliveryMode',
    'continuationIntent',
    'acceptedAsSteering',
    'MAX_AGENT_SESSIONS',
    'createLocalScope',
    'AgentSdk',
  ]) {
    assert.equal(send.includes(retired), false, retired)
  }
})

test('Codex terminal publication only broadcasts the closeout readback', () => {
  const coordinator = source('src/main/modules/agent-control/task-projection/run-coordinator.ts')
  const projectionSync = source('src/main/modules/agent-control/runtime-core/projection-sync-coordinator.ts')
  const committedPublisher = between(
    projectionSync,
    'publishCommittedScopeRunEvent(payload: ScopeRunEventPayload)',
    'recordScopeRunEvent(',
  )

  assert.equal((coordinator.match(/emitStartedScopeRunEvent\(/g) || []).length, 1)
  assert.equal((coordinator.match(/publishCommittedTerminalEvent\(/g) || []).length, 1)
  assert.doesNotMatch(coordinator, /emitScopeRunEvent\(/)
  assert.match(committedPublisher, /this\.deps\.emit\('scopeRunEvent', payload\)/)
  assert.doesNotMatch(committedPublisher, /recordScopeRunEvent|runProjection|syncTaskProjection/)
})

test('runtime startup does not relaunch retired delivery or handoff workflows', () => {
  const runtime = source('src/main/modules/agent-control/runtime-core/runtime.ts')
  const startup = between(runtime, 'async start(): Promise<void>', 'async stop(): Promise<void>')
  for (const retired of [
    'recoverPendingHandoffsOnStartup',
    'recoverPendingHandoffTakeovers',
    'reconcileInterruptedDeliveryState',
    'dynamic_delivery_fallback',
    'runCoordinator.runScoped',
  ]) {
    assert.equal(startup.includes(retired), false, retired)
  }
})

test('Codex lifecycle control has no synthetic suspend or close shortcut', () => {
  const runtime = source('src/main/modules/agent-control/runtime-core/runtime.ts')
  const host = source('src/main/modules/agent-control/runtime-core/codex-host-orchestrator.ts')
  const browserContinuation = source('src/main/modules/agent-control/runtime-core/browser-continuation-runtime.ts')
  assert.doesNotMatch(host, /interruptForSuspend|async closeSession/)
  assert.match(runtime, /lifecycleAdapter\.stopSession\(\{/)
  assert.match(runtime, /codex_handoff_requires_native_terminal_reconciliation/)
  assert.match(browserContinuation, /errorKind: 'unsupported'/)
  assert.doesNotMatch(browserContinuation, /finalizeRunOutcome|interruptForSuspend/)
})

test('native runtime and collector cannot write Ready product truth', () => {
  for (const path of [
    'src/main/modules/agent-control/codex-runtime/codex-native-runtime.ts',
    'src/main/modules/agent-control/codex-runtime/codex-turn-collector.ts',
  ]) {
    const value = source(path)
    for (const forbidden of [
      '/repositories/',
      "from '../../database'",
      'run-finalizer',
      'finalizeRunOutcome',
      'addChatMessage',
      'emitScopeRunEvent',
      'canonicalMessage',
    ]) {
      assert.equal(value.includes(forbidden), false, `${path}: ${forbidden}`)
    }
  }
})

test('renderer and IPC send surfaces contain no retired Boost or workflow fields', () => {
  const chatInput = source('src/renderer/components/agent/ChatInput.tsx')
  const chatPanel = source('src/renderer/components/agent/ChatPanel.tsx')
  const store = source('src/renderer/stores/useAgent.ts')
  const preload = source('src/preload/index.ts')
  const rendererTypes = source('src/renderer/types/electron.d.ts')
  const lifecycleGroup = source('src/main/modules/claude-bridge/ipc/agent-lifecycle-group.ts')

  for (const value of [chatInput, chatPanel, store]) {
    assert.doesNotMatch(value, /thoroughOverride|data-ready-delivery-thorough|DELIVERY_MODE_SETTING_KEY/)
  }
  assert.match(preload, /sendScoped: \(payload: SendScopedRequest\)/)
  assert.match(rendererTypes, /sendScoped: \(payload: SendScopedRequest\)/)
  assert.match(lifecycleGroup, /parseSendScopedRequest\(rawPayload\)/)
  const sendSurfaces = [
    between(preload, 'sendScoped: (payload: SendScopedRequest)', 'onIngressAdmitted:'),
    between(rendererTypes, 'sendScoped: (payload: SendScopedRequest)', 'onIngressAdmitted:'),
    between(lifecycleGroup, "ipcMain.handle('agent:sendScoped'", "ipcMain.handle('agent:createSession'"),
  ]
  for (const value of sendSurfaces) {
    assert.doesNotMatch(value, /deliveryMode\?:|continuationIntent\?:|workspaceRoots\?:|agent\?: string/)
  }
})

test('renderer cannot bypass Codex lifecycle or canonical persistence with legacy write IPC', () => {
  const preload = source('src/preload/index.ts')
  const rendererTypes = source('src/renderer/types/electron.d.ts')
  const conversationGroup = source('src/main/modules/claude-bridge/ipc/conversation-group.ts')
  const chatGroup = source('src/main/modules/claude-bridge/ipc/chat-persistence-group.ts')

  for (const retired of [
    'agent:createLocalScope',
    'chat:createConversation',
    'chat:deleteConversation',
    'chat:saveMessage',
  ]) {
    for (const value of [preload, rendererTypes, conversationGroup, chatGroup]) {
      assert.equal(value.includes(retired), false, retired)
    }
  }
})

test('Codex composition is explicit and has no SDK fallback constructor', () => {
  const runtime = source('src/main/modules/agent-control/runtime-core/runtime.ts')
  const composition = source('src/main/modules/agent-control/codex-runtime/codex-runtime-composition.ts')
  const ipc = source('src/main/modules/claude-bridge/ipc-handler.ts')
  assert.match(runtime, /codexRuntime: CodexRuntimeComposition/)
  const constructorSignature = between(runtime, 'constructor(', 'super()')
  assert.doesNotMatch(constructorSignature, /codexRuntime\?:|codexRuntime\s*=/)
  assert.match(ipc, /createE2UnavailableCodexRuntimeComposition\(\)/)
  assert.match(composition, /ingressPort: CodexIngressPort/)
  assert.match(composition, /preparedRunContextPort: CodexPreparedRunContextPort/)
  assert.match(composition, /lifecycleAdapter: ReadyCodexLifecycleAdapter<ReadyClosedCodexProductRun>/)
  assert.doesNotMatch(composition, /preparedRunPort/)
  assert.doesNotMatch(composition, /AgentSdkRuntime|ReadyAgentOrchestrator|fallback/i)
})
