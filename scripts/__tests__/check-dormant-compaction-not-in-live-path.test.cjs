'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-dormant-compaction-not-in-live-path.cjs')

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dormant-compaction-gate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function writeBaseline(root) {
  write(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts', `
import { compactAgentInputItems } from '../compaction/compact-agent-input'
`)
  write(root, 'src/main/modules/agent-control/prompt-assembly.ts', `
import { compressHistoryForPrompt } from './compaction/context-compression'
`)
  write(root, 'src/main/modules/agent-control/turn-engine.ts', `
export class TurnEngine {}
`)
  write(root, 'src/main/modules/agent-control/contracts/run-contracts.ts', `
export interface TurnEngineHost {}
`)
  write(root, 'src/main/modules/agent-control/runtime-core/execution-loop-orchestrator.ts', `
export class ExecutionLoopOrchestrator {}
`)
  write(root, 'src/main/modules/agent-control/compaction/index.ts', `
export * from './layered-compactor'
export * from './context-compression'
`)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {}
`)
}

test('gate passes for current live sdk and dormant turn-engine boundary', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when sdk runtime imports dormant compaction', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts', `
import { compactAgentInputItems } from '../compaction/compact-agent-input'
import { compressHistoryForPrompt } from '../compaction/context-compression'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('sdk_runtime_imports_dormant_compaction:context-compression')))
})

test('gate fails for a new non-dormant layered compactor import', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/runtime-core/new-live-path.ts', `
import { createLayeredCompactor } from '../compaction/layered-compactor'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unexpected_layered_compactor_import')))
})

test('gate fails when dormant TurnEngine imports context compression', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/turn-engine.ts', `
import { compressHistoryForPrompt } from './compaction/context-compression'
export class TurnEngine {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unexpected_context_compression_import:src/main/modules/agent-control/turn-engine.ts')))
})

test('gate fails when dormant TurnEngine dynamically imports context compression', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/turn-engine.ts', `
export async function loadCompression() {
  return import('./compaction/context-compression')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unexpected_context_compression_import:src/main/modules/agent-control/turn-engine.ts')))
})

test('gate fails when dormant TurnEngine imports layered compactor', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/turn-engine.ts', `
import { createLayeredCompactor } from './compaction/layered-compactor'
export class TurnEngine {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unexpected_layered_compactor_import:src/main/modules/agent-control/turn-engine.ts')))
})

test('gate fails when dormant TurnEngine dynamically imports layered compactor', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/turn-engine.ts', `
export async function loadLayeredCompactor() {
  return import('./compaction/layered-compactor')
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unexpected_layered_compactor_import:src/main/modules/agent-control/turn-engine.ts')))
})

test('gate fails when dormant TurnEngine imports compaction barrel', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/turn-engine.ts', `
import { createLayeredCompactor } from './compaction'
export class TurnEngine {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unexpected_dormant_compaction_barrel_import:src/main/modules/agent-control/turn-engine.ts')))
})

test('gate fails when dormant DirectChat imports context compression', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
import { compressHistoryForPrompt } from '../agent-control/compaction/context-compression'
export class DirectChatEngine {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unexpected_context_compression_import:src/main/modules/claude-bridge/direct-chat.ts')))
})

test('gate fails when dormant DirectChat imports compaction barrel', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
import { compressHistoryForPrompt } from '../agent-control/compaction'
export class DirectChatEngine {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unexpected_dormant_compaction_barrel_import:src/main/modules/claude-bridge/direct-chat.ts')))
})

test('gate fails when run contracts expose dormant compressContext channel', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/contracts/run-contracts.ts', `
export interface TurnEngineHost {
  requestToolLoopResponse(params: { compressContext?: () => boolean }): Promise<unknown>
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unexpected_dormant_compress_context_channel:src/main/modules/agent-control/contracts/run-contracts.ts')))
})

test('gate fails when execution loop exposes dormant compressContext channel', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/agent-control/runtime-core/execution-loop-orchestrator.ts', `
export class ExecutionLoopOrchestrator {
  requestToolLoopResponse(params: { compressContext?: () => boolean }) {
    return params.compressContext?.()
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unexpected_dormant_compress_context_channel:src/main/modules/agent-control/runtime-core/execution-loop-orchestrator.ts')))
})

test('gate fails when direct chat forwards dormant compressContext channel', (t) => {
  const root = makeRoot(t)
  writeBaseline(root)
  write(root, 'src/main/modules/claude-bridge/direct-chat.ts', `
export class DirectChatEngine {
  requestToolLoopResponse(params: { compressContext?: () => boolean }) {
    return params.compressContext?.()
  }
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('unexpected_dormant_compress_context_channel:src/main/modules/claude-bridge/direct-chat.ts')))
})
