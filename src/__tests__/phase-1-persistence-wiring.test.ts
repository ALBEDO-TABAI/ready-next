import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'

// Phase 1 — persistence-root wiring contract.
//
// These tests pin the cross-module wiring described in the audit's Phase 1
// section. They are intentionally source-grep style (not full integration
// runs) because the same audit identified divergent persist paths between
// `runtime.createConversationMessage` and `chatRepository.saveMessage`; the
// risk is regression by accident, and a contract test is the cheapest way
// to catch a future refactor that drops one of these hooks.

const RUNTIME_PATH = new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url)
// B8-D R2 — the reference-hint method bodies moved from runtime.ts into the
// delegated ReferenceHintService; the runtime keeps one-line public delegates.
// The hook-chain assertions below follow the bodies; the runtime-side
// assertions pin the delegate wiring so the chain cannot silently detach.
const REFERENCE_HINT_SERVICE_PATH = new URL('../main/modules/agent-control/runtime-core/reference-hint-service.ts', import.meta.url)
const IPC_HANDLER_PATH = new URL('../main/modules/claude-bridge/ipc-handler.ts', import.meta.url)
const CHAT_PERSISTENCE_GROUP_PATH = new URL('../main/modules/claude-bridge/ipc/chat-persistence-group.ts', import.meta.url)
const RUNTIME_MANAGER_PATH = new URL('../main/modules/skills-runtime/runtime-manager.ts', import.meta.url)
const TOOL_ERROR_METRICS_PATH = new URL('../main/modules/agent-control/tools-runtime/tool-error-metrics.ts', import.meta.url)

function readSource(url: URL): string {
  return readFileSync(url, 'utf8')
}

test('Phase 1.1 — runtime exposes persistReferenceHintAfterAssistantMessage and routes assistants through persistReferenceHintToScope', () => {
  const runtimeSource = readSource(RUNTIME_PATH)
  const serviceSource = readSource(REFERENCE_HINT_SERVICE_PATH)

  assert.match(
    runtimeSource,
    /persistReferenceHintAfterAssistantMessage\s*\(scopeId:\s*string,\s*role:\s*string\)\s*:\s*void/,
    'public hook signature is part of the runtime contract',
  )
  // B8-D R2 — the runtime hook MUST stay a delegate into ReferenceHintService
  // so the IPC → runtime → service chain cannot silently detach.
  assert.match(
    runtimeSource,
    /persistReferenceHintAfterAssistantMessage[^}]*this\.referenceHints\.persistReferenceHintAfterAssistantMessage\(/,
    'runtime hook delegates to ReferenceHintService',
  )
  // The hook MUST be a no-op for non-assistant roles to avoid wasted DB writes
  // when the chat panel saves a user message.
  assert.match(
    serviceSource,
    /persistReferenceHintAfterAssistantMessage[^}]*if\s*\(role\s*!==\s*'assistant'\)\s*return/,
    'hook short-circuits non-assistant roles',
  )
  // The hook MUST delegate to the existing persist helper rather than
  // re-implementing snapshot logic.
  assert.match(
    serviceSource,
    /persistReferenceHintAfterAssistantMessage[^}]*this\.persistReferenceHintToScope\(/,
    'hook delegates to persistReferenceHintToScope',
  )
})

test('Phase 1.1 — chat:saveMessage IPC invokes the hook after persisting the row', () => {
  const source = readSource(CHAT_PERSISTENCE_GROUP_PATH)

  // Find the chat:saveMessage handler block bounded by the next IPC handler.
  // (Screenshot-bug hotfix added a sanitize step before the saveMessage call,
  // so the block now contains a sanitizedContent local variable; widen the
  // window so the hint-persist hook is also captured.)
  const blockMatch = source.match(/'chat:saveMessage'[\s\S]*?ipcMain\.handle\('chat:createConversation'/)
  assert.ok(blockMatch, 'chat:saveMessage handler block exists')

  const block = blockMatch[0]
  assert.match(
    block,
    /deps\.saveMessage\(/,
    'saveMessage still writes the row',
  )
  assert.match(
    block,
    /deps\.persistReferenceHintAfterAssistantMessage\(\s*data\.conversationId\s*,\s*data\.role\s*\)/,
    'IPC calls the runtime hook with conversationId + role',
  )

  // Saving the row must NOT depend on the hook succeeding, but the hook MUST
  // run AFTER the row is written so the snapshot reflects the latest state.
  const saveIdx = block.indexOf('deps.saveMessage')
  const hookIdx = block.indexOf('persistReferenceHintAfterAssistantMessage')
  assert.ok(saveIdx >= 0 && hookIdx > saveIdx, 'hook fires after saveMessage')
})

test('Phase 1.2 — ensureChannelScope restores reference hint from meta_json before the message reaches orchestrator', () => {
  const source = readSource(RUNTIME_PATH)
  const blockMatch = source.match(/private ensureChannelScope[\s\S]*?\n\s{2}\}/)
  assert.ok(blockMatch, 'ensureChannelScope block exists')
  assert.match(
    blockMatch![0],
    /this\.referenceHints\.restoreReferenceHintFromScope\(scope,\s*scope\.id\)/,
    'ensureChannelScope replays persisted hint into in-memory map',
  )
})

test('Phase 1.4 — parseScopeMeta emits meta_parse_corrupted instead of silently swallowing JSON errors', () => {
  const source = readSource(REFERENCE_HINT_SERVICE_PATH)
  const blockMatch = source.match(/private parseScopeMeta[\s\S]*?\n\s{2}\}/)
  assert.ok(blockMatch, 'parseScopeMeta block exists')

  const block = blockMatch![0]
  // Must reference the registered metric symbol, not a stringly-typed name.
  assert.match(
    block,
    /TOOL_ERROR_METRICS\.metaParseCorrupted/,
    'parseScopeMeta emits via the registered metric symbol',
  )
  // Both failure modes (parse threw / parse produced non-object) must emit so
  // we can distinguish corruption from "scope had a JSON null in meta".
  assert.match(block, /reason:\s*'parse_error'/)
  assert.match(block, /reason:\s*'not_object'/)
  assert.match(block, /sample:\s*raw\.slice\(0,\s*80\)/, 'sample bounded to 80 chars to prevent log bloat')
})

test('Phase 1.4 — meta_parse_corrupted is registered in TOOL_ERROR_METRICS', () => {
  assert.equal(TOOL_ERROR_METRICS.metaParseCorrupted, 'meta_parse_corrupted')
  // Reading back from registry must also confirm the snake_case wire name
  // is what observers downstream are watching for.
  const wireName = TOOL_ERROR_METRICS.metaParseCorrupted
  assert.equal(typeof wireName, 'string')
  assert.match(wireName, /^[a-z_]+$/)
  // Registry must contain the documentation comment so future contributors
  // know why the field exists.
  const registrySource = readSource(TOOL_ERROR_METRICS_PATH)
  assert.match(registrySource, /metaParseCorrupted:\s*'meta_parse_corrupted'/)
  assert.match(registrySource, /Phase 1\.4/)
})

test('Phase 1.3 — ensurePythonVenv emits python_runtime_rebuilt only when an unsupported venv was replaced', () => {
  const source = readSource(RUNTIME_MANAGER_PATH)
  const blockMatch = source.match(/private async ensurePythonVenv[\s\S]*?\n {2}\}\n/)
  assert.ok(blockMatch, 'ensurePythonVenv block exists')
  const block = blockMatch![0]

  // Capture previous version BEFORE the rmSync so the metric can show what
  // we replaced. This is the ONLY way to distinguish "first install" from
  // "rebuild because old version was bad".
  assert.match(
    block,
    /previousVersionText[\s\S]*?await this\.getPythonVersionText\(pythonPath\)/,
    'previous version captured before rmSync',
  )
  assert.match(
    block,
    /console\.warn\([^)]*Python venv runtime unsupported/,
    'warn surfaces runtime mismatch in startup logs',
  )
  // Metric MUST be gated on previousVersionText so a fresh install (no prior
  // venv) does not falsely report a rebuild.
  assert.match(
    block,
    /if \(previousVersionText\)[\s\S]*?logAgentMetric\(\s*'python_runtime_rebuilt'/,
    'rebuild metric only fires when there was a prior venv to replace',
  )
})

test('Phase 1.3 — ensurePythonRuntimeReady is the public startup hook with structured result', () => {
  const source = readSource(RUNTIME_MANAGER_PATH)

  assert.match(
    source,
    /async ensurePythonRuntimeReady\(\)\s*:\s*Promise<\{/,
    'public method exists with structured result type',
  )
  // Must not throw — boot must not block.
  const blockMatch = source.match(/async ensurePythonRuntimeReady[\s\S]*?\n {2}\}\n/)
  assert.ok(blockMatch)
  assert.match(
    blockMatch![0],
    /try\s*\{[\s\S]*?await this\.ensurePythonVenv\(\)[\s\S]*?\}\s*catch\s*\(error\)/,
    'wrapper swallows errors so boot is not blocked by missing python',
  )
  assert.match(blockMatch![0], /console\.log\([^)]*Python runtime ready/, 'logs success banner once during boot')
})

test('Phase 1.3 — setupAgentIPC fires ensurePythonRuntimeReady after runtime.start()', () => {
  const source = readSource(IPC_HANDLER_PATH)

  // Import must be present so future refactors don't accidentally drop the
  // singleton accessor.
  assert.match(
    source,
    /import\s*\{\s*getSkillsRuntimeManager\s*\}\s*from\s*'\.\.\/skills-runtime\/runtime-manager'/,
  )

  const setupMatch = source.match(/export function setupAgentIPC[\s\S]*?if \(!runtime\)\s*\{[\s\S]*?\}/)
  assert.ok(setupMatch, 'setupAgentIPC block with runtime construction exists')
  const block = setupMatch![0]

  // Must be inside the !runtime branch (i.e. only on first construction, not
  // on dev hot-reload) and must be fire-and-forget (`void`) so it cannot
  // block IPC handler registration.
  assert.match(
    block,
    /void getSkillsRuntimeManager\(\)\.ensurePythonRuntimeReady\(\)/,
    'startup wires the venv health check fire-and-forget',
  )
  const startIdx = block.indexOf('runtime.start()')
  const ensureIdx = block.indexOf('ensurePythonRuntimeReady')
  assert.ok(startIdx >= 0 && ensureIdx > startIdx, 'venv check runs after runtime.start()')
})
