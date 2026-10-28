import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readCodexRuntimeCompositionModules } from './helpers/codex-runtime-split-sources'

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
  assert.match(committedPublisher, /this\.deps\.emit\('scopeRunEvent', authoritativePayload\)/)
  assert.match(committedPublisher, /publishedCommittedProductTerminals\.has\(runId\)/)
  assert.doesNotMatch(committedPublisher, /syncTaskProjection/)
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
  assert.equal(
    existsSync(resolve(process.cwd(), 'src/main/modules/agent-control/runtime-core/browser-continuation-runtime.ts')),
    false,
  )
  assert.doesNotMatch(host, /interruptForSuspend|async closeSession/)
  assert.match(runtime, /lifecycleAdapter\.stopSession\(request\)/)
  assert.doesNotMatch(runtime, /codex_handoff_requires_native_terminal_reconciliation/)
  assert.doesNotMatch(runtime, /async (?:suspendRun|resumeRun|respondToInteraction|completeHumanTakeover)\(/)
  const lifecycleControls = between(runtime, 'createCodexSession(', 'async resolveTrustedRequestEnvironment')
  assert.doesNotMatch(lifecycleControls, /abortActiveProductRunByAlias/)
  assert.match(lifecycleControls, /lifecycleAdapter\.resetSession\(request\)/)
  assert.match(lifecycleControls, /lifecycleAdapter\.stopSession\(request\)/)
  assert.match(lifecycleControls, /lifecycleAdapter\.closeSession\(request\)/)
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
  const settings = source('src/renderer/pages/Settings.tsx')
  const packageJson = JSON.parse(source('package.json')) as { scripts?: Record<string, string> }

  for (const value of [chatInput, chatPanel, store]) {
    assert.doesNotMatch(value, /thoroughOverride|data-ready-delivery-thorough|DELIVERY_MODE_SETTING_KEY/)
  }
  assert.doesNotMatch(
    settings,
    /Dynamic Delivery|agent\.dynamicDeliveryMode|data-ready-delivery-mode|data-ready-delivery-thorough/,
  )
  assert.doesNotMatch(settings, /AgentSettingsHub|MemorySettingsSection|UserProfileEditor/)
  assert.equal(packageJson.scripts?.['verify:dynamic-delivery'], undefined)
  assert.doesNotMatch(
    JSON.stringify(packageJson.scripts ?? {}),
    /dynamic-delivery-live|run-dynamic-delivery-tests|check-dynamic-delivery-live/,
  )
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

test('retired Agent schedules have no public or production execution entry', () => {
  const runtime = source('src/main/modules/agent-control/runtime-core/runtime.ts')
  const ipc = source('src/main/modules/claude-bridge/ipc-handler.ts')
  const preload = source('src/preload/index.ts')
  const rendererTypes = source('src/renderer/types/electron.d.ts')
  const workbench = source('src/renderer/pages/WorkbenchMode.tsx')
  const chatPanel = source('src/renderer/components/agent/ChatPanel.tsx')
  const widgetGuidance = source('src/main/modules/claude-bridge/widget-guidance.ts')
  const widgetCatalog = source('src/shared/document-widget-openui.ts')
  const packageJson = JSON.parse(source('package.json')) as { scripts?: Record<string, string> }

  for (const value of [runtime, ipc, preload, rendererTypes, workbench, chatPanel]) {
    assert.doesNotMatch(value, /scheduledTasks|ScheduledTasks|scheduledTaskCoordinator|runScheduledTaskNow|createScheduledTask/)
  }
  assert.doesNotMatch(runtime, /dispatchScheduledOccurrence|scheduled_codex_ingress_unsupported/)
  assert.doesNotMatch(preload, /electronAPI\.scheduledTasks|scheduledTasks:/)
  assert.doesNotMatch(rendererTypes, /scheduledTasks:/)
  assert.doesNotMatch(widgetGuidance, /schedule_runtime_card|自动计划状态概览/)
  assert.doesNotMatch(widgetCatalog, /schedule_runtime_card/)
  assert.equal(packageJson.scripts?.['verify:agent-schedules'], undefined)

  const skillsRuntime = source('src/main/modules/skills-runtime/ipc-handler.ts')
  const skillScheduler = source('src/main/modules/skills-runtime/skill-job-scheduler.ts')
  assert.match(skillsRuntime, /skills:schedules:/)
  assert.match(skillScheduler, /runScheduledTask/)
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
  const production = source(
    'src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts',
  ) + readCodexRuntimeCompositionModules()
  const ipc = source('src/main/modules/claude-bridge/ipc-handler.ts')
  assert.match(runtime, /codexRuntime: CodexRuntimeComposition/)
  const constructorSignature = between(runtime, 'constructor(', 'super()')
  assert.doesNotMatch(constructorSignature, /codexRuntime\?:|codexRuntime\s*=/)
  assert.match(ipc, /createCodexRuntimeComposition\(\{/)
  assert.match(ipc, /new RuntimeStartupSlot\(candidate\)[\s\S]*?startingRuntime = startup[\s\S]*?runtime = started/)
  assert.match(ipc, /await startup\.cancelAndDrain\(\)/)
  assert.doesNotMatch(ipc, /createE2UnavailableCodexRuntimeComposition/)
  assert.match(composition, /ingressPort: CodexIngressPort/)
  assert.match(composition, /preparedRunContextPort: CodexPreparedRunContextPort/)
  assert.match(composition, /lifecycleAdapter: ReadyCodexLifecycleAdapter<ReadyClosedCodexProductRun>/)
  assert.match(composition, /from ['"]\.\/codex-runtime-production-composition['"]/)
  assert.doesNotMatch(composition, /preparedRunPort/)
  assert.doesNotMatch(composition, /AgentSdkRuntime|ReadyAgentOrchestrator|fallback/i)
  assert.match(production, /export function createCodexRuntimeComposition/)
  assert.match(production, /sealIngress\(reason\)/)
  assert.doesNotMatch(
    production,
    /PromptAssembly|AgentSdkRuntime|AgentSdkTurnOrchestrator|finalizeRunOutcome|createE2Unavailable/i,
  )
})
