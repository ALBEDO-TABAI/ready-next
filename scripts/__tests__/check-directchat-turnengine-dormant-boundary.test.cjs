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
  // Phase C C4/C5（2026-07-05）：direct-chat.ts 已退役删除——passing harness 不再
  // 铺设引擎文件；该文件存在本身即违规（retired_file_resurrected）。原先 20 个
  // "DirectChat 内容形态"fixture 用例（dormant TurnEngine sender / legacy host
  // callback owners / sendMessage 各种拼写 / EventEmitter / renderer 事件）随
  // 引擎内容扫描一并退场，复活防护收敛为下方存在性用例 + 全 src/main
  // import/构造/调用扫描用例。
}

test('gate passes for sdk live execution with the DirectChat engine retired', (t) => {
  const root = makeRoot(t)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when the retired direct-chat engine file is resurrected', (t) => {
  const root = makeRoot(t)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('retired_file_resurrected:src/main/modules/claude-bridge/direct-chat.ts')))
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

test('gate fails when a retired engine file is resurrected (Phase A existence contract)', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, 'src/main/modules/agent-control/turn-engine.ts', 'export function ok() {}\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('retired_file_resurrected:src/main/modules/agent-control/turn-engine.ts')))
})

test('gate fails when the retired host-capability-dispatcher is resurrected', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, 'src/main/modules/agent-control/domain-adapters/host-capability-dispatcher.ts', 'export class HostCapabilityDispatcher {}\n')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('retired_file_resurrected:src/main/modules/agent-control/domain-adapters/host-capability-dispatcher.ts')))
})
