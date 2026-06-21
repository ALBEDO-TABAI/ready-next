'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-directchat-turnengine-dormant-boundary.cjs')

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directchat-boundary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writePassingHarness(root)
  return root
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function writePassingHarness(root) {
  write(root, 'src/main/modules/agent-control/runtime-core/orchestrator.ts', `
export class ReadyAgentOrchestrator {
  private readonly domainAdapterEngine
  private readonly sdkEngine
  constructor(domainAdapterEngine, sdkEngine) {
    this.domainAdapterEngine = domainAdapterEngine
    this.sdkEngine = sdkEngine
    this.bindEngineEvents(this.sdkEngine)
  }
  private bindEngineEvents(engine) { return engine }
  async send() {
    return await this.sdkEngine.sendMessage('session', 'message', 'run-1', {})
  }
  stop() {
    this.domainAdapterEngine.stopGeneration('session')
  }
}
`)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  stopGeneration() {}
  getDomainAdapters() { return [] }
  getSkillContextOrchestrator() { return {} }
}
`)
  write(root, 'src/main/modules/agent-control/turn-engine.ts', `
export class TurnEngine {
  async execute() { return { success: true } }
}
`)
}

test('gate passes for sdk live execution and DirectChat provider shell', (t) => {
  const root = makeRoot(t)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when DirectChat keeps a dormant TurnEngine sender', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
import { TurnEngine } from '../agent-control/turn-engine'
export class DirectChatEngine {
  private readonly turnEngine: TurnEngine
  constructor() { this.turnEngine = new TurnEngine() }
  async sendMessage() {
    return await this.turnEngine.execute({})
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_imports_turn_engine_class')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_turn_engine_member')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_sendMessage')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_calls_turn_engine_execute')))
})

test('gate fails when DirectChat imports and constructs legacy host callback owners', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
import { ExecutionLoopOrchestrator } from '../agent-control/runtime-core/execution-loop-orchestrator'
import { HostCapabilityDispatcher } from '../agent-control/domain-adapters/host-capability-dispatcher'
export class DirectChatEngine {
  private readonly executionLoopOrchestrator: ExecutionLoopOrchestrator
  private readonly hostCapabilityDispatcher: HostCapabilityDispatcher
  constructor() {
    this.executionLoopOrchestrator = new ExecutionLoopOrchestrator({ log: () => {} })
    this.hostCapabilityDispatcher = new HostCapabilityDispatcher({ executeHostTool: async () => ({ text: '' }) })
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_imports_execution_loop_orchestrator')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_constructs_execution_loop_orchestrator')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_execution_loop_orchestrator_member')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_imports_host_capability_dispatcher')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_constructs_host_capability_dispatcher')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_host_capability_dispatcher_member')))
})

test('gate fails when DirectChat aliases legacy host callback owner imports', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
import { ExecutionLoopOrchestrator as LegacyLoop } from '../agent-control/runtime-core/execution-loop-orchestrator'
import * as HostModule from '../agent-control/domain-adapters/host-capability-dispatcher'
export class DirectChatEngine {
  constructor() {
    new LegacyLoop({ log: () => {} })
    new HostModule.HostCapabilityDispatcher({ executeHostTool: async () => ({ text: '' }) })
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_imports_execution_loop_orchestrator')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_imports_host_capability_dispatcher')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_constructs_host_capability_dispatcher')))
})

test('gate fails when DirectChat side-effect imports legacy host callback owners', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
import '../agent-control/runtime-core/execution-loop-orchestrator'
import '../agent-control/domain-adapters/host-capability-dispatcher'
export class DirectChatEngine {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_imports_execution_loop_orchestrator')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_imports_host_capability_dispatcher')))
})

test('gate fails when DirectChat dynamically imports legacy host callback owners', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  async load() {
    const loop = await import('../agent-control/runtime-core/execution-loop-orchestrator')
    const host = await import('../agent-control/domain-adapters/host-capability-dispatcher')
    return { loop, host }
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_dynamic_imports_execution_loop_orchestrator')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_dynamic_imports_host_capability_dispatcher')))
})

test('gate fails when DirectChat returns or batches dynamic legacy host callback imports', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  loadLoop() {
    return import('../agent-control/runtime-core/execution-loop-orchestrator')
  }
  loadBoth() {
    return Promise.all([
      import('../agent-control/runtime-core/execution-loop-orchestrator'),
      import('../agent-control/domain-adapters/host-capability-dispatcher'),
    ])
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_dynamic_imports_execution_loop_orchestrator')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_dynamic_imports_host_capability_dispatcher')))
})

test('gate fails when DirectChat calls legacy host callback owner members', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  private readonly executionLoopOrchestrator
  private readonly hostCapabilityDispatcher
  async run() {
    await this.executionLoopOrchestrator.requestToolLoopResponse({})
    await this.hostCapabilityDispatcher.dispatch({})
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_execution_loop_orchestrator_member')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_calls_execution_loop_orchestrator_requestToolLoopResponse')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_host_capability_dispatcher_member')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_calls_host_capability_dispatcher_dispatch')))
})

test('gate fails when DirectChat declares requestSimpleText in method or property forms', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  async requestSimpleText() { return { text: '' } }
  requestToolLoopResponse = async () => ({ text: '' })
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_requestSimpleText')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_requestToolLoopResponse')))
})

test('gate fails when DirectChat declares legacy callbacks in computed or constructor-assigned forms', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  ['requestSimpleText']() { return { text: '' } }
  constructor() {
    this['requestToolLoopResponse'] = async () => ({ text: '' })
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_requestSimpleText')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_requestToolLoopResponse')))
})

test('gate fails when DirectChat declares sendMessage without TurnEngine spelling', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  async sendMessage() {
    return { success: false }
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_sendMessage')))
})

test('gate fails when DirectChat declares a non-async sendMessage method', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  sendMessage() {
    return Promise.resolve({ success: false })
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_sendMessage')))
})

test('gate fails when DirectChat declares computed sendMessage method', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  ['sendMessage']() {
    return Promise.resolve({ success: false })
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_sendMessage')))
})

test('gate fails when DirectChat declares spaced computed sendMessage method', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  [ 'sendMessage' ]() {
    return Promise.resolve({ success: false })
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_sendMessage')))
})

test('gate fails when DirectChat declares typed sendMessage arrow property', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  sendMessage: () => Promise<unknown> = async () => ({ success: false })
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_sendMessage')))
})

test('gate fails when DirectChat declares multiline typed sendMessage arrow property', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  sendMessage:
    () => Promise<unknown> = async () => ({ success: false })
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_sendMessage')))
})

test('gate fails when DirectChat declares computed sendMessage arrow property', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  ['sendMessage'] = async () => ({ success: false })
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_sendMessage')))
})

test('gate fails when DirectChat declares multiline computed sendMessage arrow property', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  ['sendMessage']:
    () => Promise<unknown> = async () => ({ success: false })
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_sendMessage')))
})

test('gate fails when DirectChat assigns this computed sendMessage in constructor', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  constructor() {
    this['sendMessage'] = async () => ({ success: false })
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_declares_sendMessage')))
})

test('gate fails when orchestrator sends through DirectChat/domainAdapterEngine', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/orchestrator.ts', `
export class ReadyAgentOrchestrator {
  private readonly domainAdapterEngine
  private readonly sdkEngine
  constructor(domainAdapterEngine, sdkEngine) {
    this.domainAdapterEngine = domainAdapterEngine
    this.sdkEngine = sdkEngine
    this.bindEngineEvents(this.sdkEngine)
  }
  private bindEngineEvents(engine) { return engine }
  async send() {
    return await this.domainAdapterEngine.sendMessage('session', 'message')
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('orchestrator_missing_sdk_sendMessage')))
  assert.ok(result.errors.some((error) => error.includes('orchestrator_calls_domain_adapter_sendMessage')))
})

test('gate fails when orchestrator forwards renderer tool-action plumbing to DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/orchestrator.ts', `
export class ReadyAgentOrchestrator {
  private readonly domainAdapterEngine
  private readonly sdkEngine
  constructor(domainAdapterEngine, sdkEngine) {
    this.domainAdapterEngine = domainAdapterEngine
    this.sdkEngine = sdkEngine
    this.bindEngineEvents(this.sdkEngine)
  }
  private bindEngineEvents(engine) { return engine }
  async send() {
    return await this.sdkEngine.sendMessage('session', 'message', 'run-1', {})
  }
  setRendererToolActionRequester(requester) {
    this.domainAdapterEngine.setRendererToolActionRequester(requester)
    this.sdkEngine.setRendererToolActionRequester(requester)
  }
  setCancelPendingToolActions(canceller) {
    this.domainAdapterEngine.setCancelPendingToolActions(canceller)
    this.sdkEngine.setCancelPendingToolActions(canceller)
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('orchestrator_forwards_renderer_tool_action_requester_to_direct_chat')))
  assert.ok(result.errors.some((error) => error.includes('orchestrator_forwards_tool_action_canceller_to_direct_chat')))
})

test('gate fails when DirectChat extends EventEmitter', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
import { EventEmitter } from 'events'
export class DirectChatEngine extends EventEmitter {
  stopGeneration() {}
  getDomainAdapters() { return [] }
  getSkillContextOrchestrator() { return {} }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_imports_events_module')))
  assert.ok(result.errors.some((error) => error.includes('direct_chat_extends_event_emitter')))
})

test('gate fails when DirectChat emits renderer-facing events', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  emit() {}
  stopGeneration() {}
  getDomainAdapters() { return [] }
  getSkillContextOrchestrator() { return {} }
  announce(payload) {
    this.emit('output', payload)
    this.emit('toolAction', payload)
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('direct_chat_emits_renderer_event')))
})

test('gate fails when production code imports the TurnEngine class outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import { TurnEngine } from '../turn-engine'
export const engine = new TurnEngine()
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_imports_turn_engine_class')))
})

test('gate fails for aliased multiline TurnEngine imports and generic execute variables', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import {
  TurnEngine as LegacyTurn
} from '../turn-engine'
export async function run() {
  const engine = new LegacyTurn()
  return await engine.execute({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_imports_turn_engine_class')))
  assert.ok(result.errors.some((error) => error.includes('production_constructs_turn_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for namespace TurnEngine construction and inline execute', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import * as LegacyTurnEngine from '../turn-engine'
export async function run() {
  return await new LegacyTurnEngine.TurnEngine().execute({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_imports_turn_engine_class')))
  assert.ok(result.errors.some((error) => error.includes('production_constructs_turn_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for the real DirectChat-style this.turnEngine execute spelling outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export class LegacyRunner {
  constructor(turnEngine) { this.turnEngine = turnEngine }
  async run() {
    return await this.turnEngine.execute({})
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for a bare turnEngine execute call outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export async function run(turnEngine) {
  return await turnEngine.execute({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for optional turnEngine execute call outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export async function run(localTurnEngine) {
  return await localTurnEngine?.execute({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for optional bracket turnEngine execute call outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export async function run(localTurnEngine) {
  return await localTurnEngine?.['execute']({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for optional this.turnEngine execute call outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export class LegacyRunner {
  constructor(turnEngine) { this.turnEngine = turnEngine }
  async run() {
    return await this.turnEngine?.execute({})
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for optional bracket this.turnEngine execute call outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export class LegacyRunner {
  constructor(turnEngine) { this.turnEngine = turnEngine }
  async run() {
    return await this.turnEngine?.['execute']({})
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for optional-call turnEngine execute outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export async function run(localTurnEngine) {
  return await localTurnEngine.execute?.({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for optional-call bracket turnEngine execute outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export async function run(localTurnEngine) {
  return await localTurnEngine['execute']?.({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for optional-call this.turnEngine execute outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export class LegacyRunner {
  constructor(turnEngine) { this.turnEngine = turnEngine }
  async run() {
    return await this.turnEngine.execute?.({})
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for inline new TurnEngine execute outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import { TurnEngine } from '../turn-engine'
export async function run() {
  return await new TurnEngine().execute({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_imports_turn_engine_class')))
  assert.ok(result.errors.some((error) => error.includes('production_constructs_turn_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for inline new TurnEngine bracket execute outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import { TurnEngine } from '../turn-engine'
export async function run() {
  return await new TurnEngine()['execute']({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_imports_turn_engine_class')))
  assert.ok(result.errors.some((error) => error.includes('production_constructs_turn_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for inline new TurnEngine optional bracket execute outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import { TurnEngine } from '../turn-engine'
export async function run() {
  return await new TurnEngine()?.['execute']({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_imports_turn_engine_class')))
  assert.ok(result.errors.some((error) => error.includes('production_constructs_turn_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails when TurnEngine appears later in a mixed import specifier list', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import { OtherThing, TurnEngine } from '../turn-engine'
export const engine = new TurnEngine()
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_imports_turn_engine_class')))
  assert.ok(result.errors.some((error) => error.includes('production_constructs_turn_engine')))
})

test('gate fails when production code calls a turnEngine execute method outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export async function run(localTurnEngine) {
  return await localTurnEngine.execute({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails when production code creates a DirectChatEngine and sends through it', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import { DirectChatEngine as LegacyDirectChat } from '../../claude-bridge/direct-chat'
export async function run() {
  const engine = new LegacyDirectChat()
  return await engine.sendMessage('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_imports_direct_chat_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_constructs_direct_chat_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
})

test('gate fails when production code calls DirectChatEngine via bracket sendMessage', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import type { DirectChatEngine } from '../../claude-bridge/direct-chat'
export async function run(engine: DirectChatEngine) {
  return await engine['sendMessage']('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_non_sdk_sendMessage')))
})

test('gate fails when production code calls DirectChatEngine via optional bracket sendMessage', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import type { DirectChatEngine } from '../../claude-bridge/direct-chat'
export async function run(engine: DirectChatEngine) {
  return await engine?.['sendMessage']('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_non_sdk_sendMessage')))
})

test('gate fails when production code optional-calls DirectChatEngine sendMessage', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import type { DirectChatEngine } from '../../claude-bridge/direct-chat'
export async function run(engine: DirectChatEngine) {
  return await engine.sendMessage?.('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_non_sdk_sendMessage')))
})

test('gate fails when production code optional-calls bracket DirectChatEngine sendMessage', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import type { DirectChatEngine } from '../../claude-bridge/direct-chat'
export async function run(engine: DirectChatEngine) {
  return await engine['sendMessage']?.('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_non_sdk_sendMessage')))
})

test('gate fails when production code uses a DirectChat namespace import to send', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import * as DirectChat from '../../claude-bridge/direct-chat'
export async function run() {
  return await new DirectChat.DirectChatEngine().sendMessage('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_imports_direct_chat_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_constructs_direct_chat_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
})

test('gate fails when production code calls inline DirectChat construction via bracket sendMessage', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import * as DirectChat from '../../claude-bridge/direct-chat'
export async function run() {
  return await new DirectChat.DirectChatEngine()['sendMessage']('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
})

test('gate fails when production code calls inline DirectChat construction via optional bracket sendMessage', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import * as DirectChat from '../../claude-bridge/direct-chat'
export async function run() {
  return await new DirectChat.DirectChatEngine()?.['sendMessage']('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
})

test('gate fails when production code dynamically imports DirectChatEngine and sends', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export async function run() {
  const { DirectChatEngine: LegacyDirectChat } = await import('../../claude-bridge/direct-chat')
  const engine = new LegacyDirectChat()
  return await engine.sendMessage('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_dynamic_imports_direct_chat_module')))
  assert.ok(result.errors.some((error) => error.includes('production_constructs_direct_chat_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
})

test('gate fails when production code dynamically imports direct-chat with then', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export function run() {
  return import('../../claude-bridge/direct-chat').then(({ DirectChatEngine }) => new DirectChatEngine().sendMessage('s', 'm'))
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_dynamic_imports_direct_chat_module')))
})

test('gate fails when production code dynamically imports TurnEngine and executes it', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export async function run() {
  const { TurnEngine: LegacyTurn } = await import('../turn-engine')
  const engine = new LegacyTurn()
  return await engine.execute({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_dynamic_imports_turn_engine_module')))
  assert.ok(result.errors.some((error) => error.includes('production_constructs_turn_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails when production code dynamically imports a namespace and executes TurnEngine', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export async function run() {
  const legacy = await import('../turn-engine')
  const engine = new legacy.TurnEngine()
  return await engine.execute({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_dynamic_imports_turn_engine_module')))
  assert.ok(result.errors.some((error) => error.includes('production_constructs_turn_engine')))
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails when production code stores a runtime TurnEngine dynamic import promise', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export function run() {
  const legacy = import('../turn-engine')
  return legacy
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_dynamic_imports_turn_engine_module')))
})

test('gate fails when a type-only DirectChatEngine parameter sends through DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import type { DirectChatEngine } from '../../claude-bridge/direct-chat'
export async function run(engine: DirectChatEngine) {
  return await engine.sendMessage('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
})

test('gate fails when an inline imported DirectChatEngine type sends through DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
export async function run(engine: import('../../claude-bridge/direct-chat').DirectChatEngine) {
  return await engine.sendMessage('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
})

test('gate fails when an inline imported DirectChatEngine type alias sends through DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
type LegacyDirectChat =
  import('../../claude-bridge/direct-chat').DirectChatEngine

export async function run(engine: LegacyDirectChat) {
  return await engine.sendMessage('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
})

test('gate fails when a static DirectChatEngine type alias sends through DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
import type { DirectChatEngine as LegacyDirectChat } from '../../claude-bridge/direct-chat'
type Engine = LegacyDirectChat

export async function run(engine: Engine) {
  return await engine.sendMessage('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_direct_chat_sendMessage')))
})

test('gate fails when a TurnEngine type alias executes outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
type LegacyTurn =
  import('../turn-engine').TurnEngine

export async function run(engine: LegacyTurn) {
  return await engine.execute({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails when a TurnEngine type alias bracket-executes outside DirectChat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
type LegacyTurn =
  import('../turn-engine').TurnEngine

export async function run(engine: LegacyTurn) {
  return await engine['execute']({})
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_turn_engine_execute')))
})

test('gate fails for any non-SDK production sendMessage call', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/legacy-runner.ts', `
interface Sender {
  sendMessage(session: string, message: string): Promise<unknown>
}

export async function run(engine: Sender) {
  return await engine.sendMessage('session', 'message')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('production_calls_non_sdk_sendMessage')))
})

test('gate allows non-DirectChatEngine type-only imports from direct-chat', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/multimodal-types.ts', `
import type { MultimodalBlock } from '../../claude-bridge/direct-chat'
export function pass(block: MultimodalBlock) {
  return block
}
`)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when DirectChat events are rebound', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/agent-control/runtime-core/orchestrator.ts', `
export class ReadyAgentOrchestrator {
  private readonly domainAdapterEngine
  private readonly sdkEngine
  constructor(domainAdapterEngine, sdkEngine) {
    this.domainAdapterEngine = domainAdapterEngine
    this.sdkEngine = sdkEngine
    this.bindEngineEvents(this.domainAdapterEngine)
  }
  private bindEngineEvents(engine) { return engine }
  async send() {
    return await this.sdkEngine.sendMessage('session', 'message', 'run-1', {})
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('orchestrator_binds_domain_adapter_events')))
})
