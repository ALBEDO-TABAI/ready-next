import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'

// Phase 1 — persistence-root wiring contract.
//
// These tests pin the cross-module wiring described in the audit's Phase 1
// section. They are intentionally source-grep style (not full integration
// runs) because the risk is regression by accident, and a contract test is
// the cheapest way to catch a future refactor that drops one of these hooks.

const RUNTIME_PATH = new URL('../main/modules/agent-control/runtime-core/runtime.ts', import.meta.url)
// B8-D R2 — the reference-hint method bodies moved from runtime.ts into the
// delegated ReferenceHintService; the runtime keeps one-line public delegates.
// The hook-chain assertions below follow the bodies; the runtime-side
// assertions pin the delegate wiring so the chain cannot silently detach.
const REFERENCE_HINT_SERVICE_PATH = new URL('../main/modules/agent-control/runtime-core/reference-hint-service.ts', import.meta.url)
// B8-D R4 — the ensureChannelScope body moved from runtime.ts into the
// delegated ConversationScopeStore. B8-D R5 — the remote-channel cluster (its
// only caller) moved into RemoteChannelService, whose deps bind the store's
// public face directly; the old runtime private delegate is gone. The body
// assertion follows the body; the runtime-side assertions pin the deps wiring
// so the replay chain cannot silently detach.
const CONVERSATION_SCOPE_STORE_PATH = new URL('../main/modules/agent-control/runtime-core/conversation-scope-store.ts', import.meta.url)
const IPC_HANDLER_PATH = new URL('../main/modules/claude-bridge/ipc-handler.ts', import.meta.url)
const CHAT_PERSISTENCE_GROUP_PATH = new URL('../main/modules/claude-bridge/ipc/chat-persistence-group.ts', import.meta.url)
const RUNTIME_MANAGER_PATH = new URL('../main/modules/skills-runtime/runtime-manager.ts', import.meta.url)
// B8-D M2 — the python-runtime bodies (ensurePythonVenv rebuild branch and the
// ensurePythonRuntimeReady wrapper) moved verbatim from runtime-manager.ts into
// the delegated PythonRuntimeProvisioner; the manager keeps same-name one-line
// delegates. The body-level assertions below follow the bodies; the manager-side
// assertion pins the public delegate face.
const PYTHON_RUNTIME_PROVISIONER_PATH = new URL('../main/modules/skills-runtime/python-runtime-provisioner.ts', import.meta.url)
const TOOL_ERROR_METRICS_PATH = new URL('../main/modules/agent-control/tools-runtime/tool-error-metrics.ts', import.meta.url)

function readSource(url: URL): string {
  return readFileSync(url, 'utf8')
}

test('Phase 1.1 — canonical conversation-message persistence snapshots assistant reference hints', () => {
  const runtimeSource = readSource(RUNTIME_PATH)
  const serviceSource = readSource(REFERENCE_HINT_SERVICE_PATH)
  const storeSource = readSource(CONVERSATION_SCOPE_STORE_PATH)
  const blockMatch = storeSource.match(/createConversationMessage\([\s\S]*?\n\s{2}\}/)

  assert.ok(blockMatch, 'canonical createConversationMessage block exists')
  assert.match(
    blockMatch![0],
    /payload\.role\s*===\s*'assistant'[\s\S]*this\.deps\.persistReferenceHintToScope\(scopeId\)/,
    'canonical assistant-message persistence snapshots the reference hint',
  )
  assert.doesNotMatch(runtimeSource, /persistReferenceHintAfterAssistantMessage/)
  assert.doesNotMatch(serviceSource, /persistReferenceHintAfterAssistantMessage/)
})

test('Codex E1 — renderer direct message persistence IPC is retired', () => {
  const source = readSource(CHAT_PERSISTENCE_GROUP_PATH)
  assert.doesNotMatch(source, /chat:saveMessage|deps\.saveMessage/)
})

test('Phase 1.2 — ensureChannelScope restores reference hint from meta_json before the message reaches orchestrator', () => {
  const runtimeSource = readSource(RUNTIME_PATH)
  const storeSource = readSource(CONVERSATION_SCOPE_STORE_PATH)

  // Body home (B8-D R4): the replay hook fires inside the store's
  // ensureChannelScope, through the injected ReferenceHintService callback.
  const blockMatch = storeSource.match(/ensureChannelScope\([\s\S]*?\n\s{2}\}/)
  assert.ok(blockMatch, 'ensureChannelScope block exists in ConversationScopeStore')
  assert.match(
    blockMatch![0],
    /this\.deps\.restoreReferenceHintFromScope\(scope,\s*scope\.id\)/,
    'ensureChannelScope replays persisted hint into in-memory map',
  )

  // Runtime wiring (B8-D R5): the remote-channel cluster moved into
  // RemoteChannelService and the old private delegate is gone; the service's
  // `ensureChannelScope` dep MUST stay bound to the store body so the hint
  // replay keeps firing on every channel-scope creation.
  assert.match(
    runtimeSource,
    /ensureChannelScope:\s*\(channelId,\s*remoteThread,\s*agent,\s*sender\)\s*=>\s*\n?\s*this\.conversationScopes\.ensureChannelScope\(/,
    'RemoteChannelService deps bind ensureChannelScope to ConversationScopeStore',
  )
  assert.match(
    runtimeSource,
    /restoreReferenceHintFromScope:\s*\(scope,\s*scopeId\)\s*=>\s*\n?\s*this\.referenceHints\.restoreReferenceHintFromScope\(scope,\s*scopeId\)/,
    'store deps bind the ReferenceHintService replay hook',
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
  const source = readSource(PYTHON_RUNTIME_PROVISIONER_PATH)
  const blockMatch = source.match(/async ensurePythonVenv[\s\S]*?\n {2}\}\n/)
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
  // Must not throw — boot must not block. The wrapper body followed the
  // python-runtime cluster into PythonRuntimeProvisioner (B8-D M2).
  const blockMatch = readSource(PYTHON_RUNTIME_PROVISIONER_PATH).match(/async ensurePythonRuntimeReady[\s\S]*?\n {2}\}\n/)
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
