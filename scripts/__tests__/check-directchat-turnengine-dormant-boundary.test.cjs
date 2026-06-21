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
import { TurnEngine } from '../agent-control/turn-engine'
export class DirectChatEngine {
  private readonly turnEngine: TurnEngine
  constructor() { this.turnEngine = new TurnEngine() }
  async sendMessage() {
    return await this.turnEngine.execute({})
  }
}
`)
  write(root, 'src/main/modules/agent-control/turn-engine.ts', `
export class TurnEngine {
  async execute() { return { success: true } }
}
`)
}

test('gate passes for sdk live execution and dormant DirectChat execution method', (t) => {
  const root = makeRoot(t)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
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
