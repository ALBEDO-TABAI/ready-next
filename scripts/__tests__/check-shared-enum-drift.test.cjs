'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-shared-enum-drift.cjs')
const REPO_ROOT = path.resolve(__dirname, '../..')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function writeFile(rootDir, rel, body) {
  const p = path.join(rootDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-enum-drift-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  writePassingHarness(dir)
  return dir
}

function writePassingHarness(root) {
  writeFile(root, 'src/shared/run-meta-terminal-status.ts', `
export const RUN_META_TERMINAL_STATUSES = ['done', 'error', 'cancelled'] as const
`)
  writeFile(root, 'scripts/check-run-finalize-funnel.cjs', `
const RUN_META_TERMINAL_STATUS_REL = 'src/shared/run-meta-terminal-status.ts'
const TERMINAL_RUN_META_STATUSES = readConstArray(RUN_META_TERMINAL_STATUS_REL, 'RUN_META_TERMINAL_STATUSES')
`)
  writeFile(root, 'src/main/modules/agent-control/contracts/task-open-status.ts', `
export function isPausedTaskStatus(value) { return value === 'blocked' || value === 'recoverable_paused' || value === 'budget_paused' }
export function isDirectlyResumableTaskStatus(value) { return value === 'recoverable_paused' || value === 'budget_paused' }
`)
  writeFile(root, 'src/main/modules/agent-control/turn-engine.ts', `
import { isDirectlyResumableTaskStatus } from './contracts/task-open-status'
export function ok(status) { return isDirectlyResumableTaskStatus(status) }
`)
  writeFile(root, 'src/main/modules/agent-control/contracts/run-contracts.ts', `
import { isDirectlyResumableTaskStatus, isPausedTaskStatus } from './task-open-status'
export function ok(status) { if (isDirectlyResumableTaskStatus(status)) return 'recoverable_paused'; if (isPausedTaskStatus(status)) return 'blocked'; return 'unknown' }
`)
  writeFile(root, 'src/main/modules/agent-control/runtime-core/turn-frame-resolver.ts', `
import { isDirectlyResumableTaskStatus, isPausedTaskStatus } from '../contracts/task-open-status'
export function ok(status) { if (isDirectlyResumableTaskStatus(status)) return 'recoverable_paused'; if (isPausedTaskStatus(status)) return 'blocked'; return 'unknown' }
`)
  writeFile(root, 'src/main/modules/agent-control/task-projection/run-state-schema.ts', `
export const NORMALIZED_RUN_STATE_STATUSES = ['running', 'done', 'failed', 'cancelled', 'blocked'] as const
export type NormalizedRunStateStatus = typeof NORMALIZED_RUN_STATE_STATUSES[number]
export function isNormalizedRunStateStatus(value) { return NORMALIZED_RUN_STATE_STATUSES.includes(value) }
`)
  writeFile(root, 'src/main/modules/agent-control/detached-skill-task-tracker.ts', `
import type { NormalizedRunStateStatus } from './task-projection/run-state-schema'
export type DetachedSkillTaskStatus = NormalizedRunStateStatus
`)
  writeFile(root, 'src/main/modules/agent-control/contracts/error-kinds.ts', `
export const PROVIDER_ERROR_KINDS = {
  providerRequestFailed: { code: 'provider_request_failed' },
  providerThinkingEchoRequired: { code: 'provider_thinking_echo_required' },
}
export const DETACHED_TASK_ERROR_KINDS = {
  taskFailed: { code: 'detached_task_failed' },
  notFound: { code: 'detached_task_not_found' },
  forbidden: { code: 'detached_task_forbidden' },
  runtimeUnavailable: { code: 'detached_task_runtime_unavailable' },
  skillActionUnknown: { code: 'detached_task_skill_action_unknown' },
  skillNotLoaded: { code: 'detached_task_skill_not_loaded' },
  hintRequired: { code: 'detached_task_hint_required' },
  visibilityInternal: { code: 'detached_task_visibility_internal' },
  startFailed: { code: 'detached_task_start_failed' },
}
export const SEND_IM_ERROR_KINDS = {
  blockedExternal: { code: 'blocked_external' },
  sendFailed: { code: 'send_failed' },
  sidecarUnavailable: { code: 'sidecar_unavailable' },
  channelNotReady: { code: 'channel_not_ready' },
  directoryNotSupported: { code: 'directory_not_supported' },
  fileNotFound: { code: 'file_not_found' },
  fileAmbiguous: { code: 'file_ambiguous' },
  intentNegated: { code: 'intent_negated' },
}
export const TARGET_DOCUMENT_ERROR_KINDS = {
  preservedContentMissing: { code: 'target_document_preserved_content_missing' },
  openUnavailable: { code: 'target_document_open_unavailable' },
  openFailed: { code: 'target_document_open_failed' },
  saveUnavailable: { code: 'target_document_save_unavailable' },
  saveFailed: { code: 'target_document_save_failed' },
  required: { code: 'target_document_required' },
}
export const BROWSER_TOOL_ERROR_KINDS = {
  browserToolFailed: { code: 'browser_tool_failed' },
}
export const TOOL_ADMISSION_ERROR_KINDS = {
  toolNotRegistered: { code: 'tool_not_registered' },
  authorizationDenied: { code: 'authorization_denied' },
  internalToolNotAllowed: { code: 'internal_tool_not_allowed' },
  toolRestrictedThisTurn: { code: 'tool_restricted_this_turn' },
  deniedByUserNegation: { code: 'denied_by_user_negation' },
}
export const MCP_TOOL_ERROR_KINDS = {
  toolUnregistered: { code: 'mcp_tool_unregistered' },
  authorizationDenied: { code: 'mcp_authorization_denied' },
  clientMissing: { code: 'mcp_client_missing' },
  toolFailed: { code: 'mcp_tool_failed' },
}
export const ACTION_CONFIRMATION_ERROR_KINDS = {
  deniedManualOnly: { code: 'denied_manual_only' },
  deniedPendingConfirmation: { code: 'denied_pending_confirmation' },
  confirmationDeniedByUser: { code: 'confirmation_denied_by_user' },
  confirmationExpired: { code: 'confirmation_expired' },
}
export const SPECIALIST_BLUEPRINT_ERROR_KINDS = {
  verbatimSourceUnavailable: { code: 'verbatim_source_unavailable' },
  verbatimMismatch: { code: 'verbatim_mismatch' },
  confirmedBlueprintImmutable: { code: 'confirmed_blueprint_immutable' },
}
export const WEB_RESEARCH_ERROR_KINDS = {
  webSearchFailed: { code: 'web_search_failed' },
  webFetchFailed: { code: 'web_fetch_failed' },
}
`)
  writeFile(root, 'src/main/modules/tools/skills-tools.ts', `
import { DETACHED_TASK_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const output = { data: { errorKind: DETACHED_TASK_ERROR_KINDS.notFound.code } }
`)
  writeFile(root, 'src/main/modules/agent-control/skills/skill-task-tracker.ts', `
import { DETACHED_TASK_ERROR_KINDS } from '../contracts/error-kinds'
export const failureKind = DETACHED_TASK_ERROR_KINDS.taskFailed.code
`)
  writeFile(root, 'src/main/modules/tools/send-im-skill-tool.ts', `
import { SEND_IM_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const output = { data: { errorKind: SEND_IM_ERROR_KINDS.fileNotFound.code } }
`)
  writeFile(root, 'src/main/modules/claude-bridge/llm-resilience.ts', `
import { PROVIDER_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const classification = { errorKind: PROVIDER_ERROR_KINDS.providerThinkingEchoRequired.code }
export function fail(ToolDomainError) { throw new ToolDomainError(PROVIDER_ERROR_KINDS.providerRequestFailed.code, 'blocked') }
`)
  writeFile(root, 'src/main/modules/agent-control/domain-adapters/message-capability-filter.ts', `
import { PROVIDER_ERROR_KINDS } from '../contracts/error-kinds'
export function fail(ToolDomainError) { throw new ToolDomainError(PROVIDER_ERROR_KINDS.providerRequestFailed.code, 'blocked') }
`)
  writeFile(root, 'src/main/modules/agent-control/thinking-compatibility.ts', `
import { PROVIDER_ERROR_KINDS } from './contracts/error-kinds'
export function fail(ToolDomainError) { throw new ToolDomainError(PROVIDER_ERROR_KINDS.providerRequestFailed.code, 'blocked') }
`)
  writeFile(root, 'src/main/modules/claude-bridge/error-contract.ts', `
import { PROVIDER_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const terminalKinds = new Set([PROVIDER_ERROR_KINDS.providerRequestFailed.code, PROVIDER_ERROR_KINDS.providerThinkingEchoRequired.code])
`)
  writeFile(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts', `
import { TARGET_DOCUMENT_ERROR_KINDS, TOOL_ADMISSION_ERROR_KINDS } from '../contracts/error-kinds'
export const output = { data: { errorKind: TARGET_DOCUMENT_ERROR_KINDS.required.code } }
export const admission = TOOL_ADMISSION_ERROR_KINDS.toolRestrictedThisTurn.code
`)
  writeFile(root, 'src/main/modules/tools/browser-failure-output.ts', `
import { BROWSER_TOOL_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const output = { data: { errorKind: BROWSER_TOOL_ERROR_KINDS.browserToolFailed.code } }
export const fallback = BROWSER_TOOL_ERROR_KINDS.browserToolFailed.code
`)
  writeFile(root, 'src/main/modules/tools/tool-executor.ts', `
import { ACTION_CONFIRMATION_ERROR_KINDS, BROWSER_TOOL_ERROR_KINDS, TOOL_ADMISSION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const output = { data: { errorKind: BROWSER_TOOL_ERROR_KINDS.browserToolFailed.code } }
export const admission = { data: { errorKind: TOOL_ADMISSION_ERROR_KINDS.toolNotRegistered.code } }
export const confirmation = ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code
`)
  writeFile(root, 'src/main/modules/agent-control/tools-runtime/tool-runtime.ts', `
import { TOOL_ADMISSION_ERROR_KINDS } from '../contracts/error-kinds'
export const output = { data: { errorKind: TOOL_ADMISSION_ERROR_KINDS.toolRestrictedThisTurn.code } }
`)
  writeFile(root, 'src/main/modules/agent-control/tools-runtime/tool-registry.ts', `
import { TOOL_ADMISSION_ERROR_KINDS } from '../contracts/error-kinds'
export const output = { data: { errorKind: TOOL_ADMISSION_ERROR_KINDS.toolNotRegistered.code } }
`)
  writeFile(root, 'src/main/modules/tools/mcp-tools.ts', `
import { MCP_TOOL_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export function fail(ToolDomainError) { throw new ToolDomainError(MCP_TOOL_ERROR_KINDS.authorizationDenied.code, 'denied') }
export const fallback = MCP_TOOL_ERROR_KINDS.toolFailed.code
`)
  writeFile(root, 'src/main/modules/tools/tool-result-envelope.ts', `
import {
  ACTION_CONFIRMATION_ERROR_KINDS,
  MCP_TOOL_ERROR_KINDS,
  TOOL_ADMISSION_ERROR_KINDS,
  WEB_RESEARCH_ERROR_KINDS,
} from '../agent-control/contracts/error-kinds'
const EXPLICIT_KIND_MAP = {
  input_validation: 'arg_error',
  persistence_failed: 'internal_error',
  waiting_task_gone: 'not_found',
  card_resolver_missed: 'internal_error',
  overlapping_card: 'denied_by_policy',
  user_skipped: 'denied_by_policy',
  user_cancelled: 'denied_by_policy',
  aborted: 'internal_error',
  timeout: 'network_error',
  cancel_persist_failed: 'internal_error',
  provider_request_failed: 'upstream_error',
  provider_thinking_echo_required: 'upstream_error',
  detached_task_failed: 'internal_error',
  detached_task_not_found: 'not_found',
  detached_task_forbidden: 'denied_by_policy',
  detached_task_runtime_unavailable: 'upstream_error',
  detached_task_skill_action_unknown: 'not_found',
  detached_task_skill_not_loaded: 'not_found',
  detached_task_hint_required: 'arg_error',
  detached_task_visibility_internal: 'denied_by_policy',
  detached_task_start_failed: 'internal_error',
  blocked_external: 'denied_by_policy',
  send_failed: 'upstream_error',
  sidecar_unavailable: 'upstream_error',
  channel_not_ready: 'upstream_error',
  directory_not_supported: 'arg_error',
  file_not_found: 'not_found',
  file_ambiguous: 'arg_error',
  intent_negated: 'denied_by_policy',
  target_document_preserved_content_missing: 'arg_error',
  target_document_open_unavailable: 'upstream_error',
  target_document_open_failed: 'upstream_error',
  target_document_save_unavailable: 'upstream_error',
  target_document_save_failed: 'upstream_error',
  target_document_required: 'arg_error',
  browser_tool_failed: 'upstream_error',
  tool_not_registered: 'not_found',
  authorization_denied: 'denied_by_policy',
  internal_tool_not_allowed: 'denied_by_policy',
  tool_restricted_this_turn: 'denied_by_policy',
  denied_by_user_negation: 'denied_by_policy',
  [MCP_TOOL_ERROR_KINDS.toolUnregistered.code]: 'not_found',
  [MCP_TOOL_ERROR_KINDS.authorizationDenied.code]: 'denied_by_policy',
  [MCP_TOOL_ERROR_KINDS.clientMissing.code]: 'upstream_error',
  [MCP_TOOL_ERROR_KINDS.toolFailed.code]: 'upstream_error',
  [ACTION_CONFIRMATION_ERROR_KINDS.deniedManualOnly.code]: 'denied_by_policy',
  denied_pending_confirmation: 'denied_by_policy',
  confirmation_denied_by_user: 'denied_by_policy',
  confirmation_expired: 'denied_by_policy',
  verbatim_source_unavailable: 'arg_error',
  verbatim_mismatch: 'arg_error',
  confirmed_blueprint_immutable: 'denied_by_policy',
  [WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code]: 'upstream_error',
  [WEB_RESEARCH_ERROR_KINDS.webFetchFailed.code]: 'upstream_error',
}
`)
  writeFile(root, 'src/main/modules/tools/browser-tools.ts', `
import { ACTION_CONFIRMATION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const manualOnly = ACTION_CONFIRMATION_ERROR_KINDS.deniedManualOnly.code
export const pendingConfirmation = ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code
`)
  writeFile(root, 'src/main/modules/tools/builtins/propose-specialist-blueprint.ts', `
import { SPECIALIST_BLUEPRINT_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
export type VerbatimFailure =
  | typeof SPECIALIST_BLUEPRINT_ERROR_KINDS.verbatimSourceUnavailable.code
  | typeof SPECIALIST_BLUEPRINT_ERROR_KINDS.verbatimMismatch.code
export const output = { data: { errorKind: SPECIALIST_BLUEPRINT_ERROR_KINDS.confirmedBlueprintImmutable.code } }
`)
  writeFile(root, 'src/main/modules/tools/builtins/web-search.ts', `
import { WEB_RESEARCH_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
export const failure = WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code
`)
  writeFile(root, 'src/main/modules/tools/builtins/web-fetch.ts', `
import { WEB_RESEARCH_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
export const failure = WEB_RESEARCH_ERROR_KINDS.webFetchFailed.code
`)
}

test('shared enum drift gate passes on the real codebase', () => {
  const result = runIn(REPO_ROOT)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /check-shared-enum-drift: ok/)
})

test('shared enum drift gate fails when run finalize gate copies terminal statuses', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'scripts/check-run-finalize-funnel.cjs', `
const TERMINAL_RUN_META_STATUSES = ['done', 'error', 'cancelled']
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /run_finalize_gate_local_array/)
})

test('shared enum drift gate fails on inline paused predicates', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/turn-engine.ts', `
export function bad(status) { return status === 'recoverable_paused' || status === 'budget_paused' }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /inline_paused_predicate/)
})

test('shared enum drift gate fails when detached status union is copied', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/detached-skill-task-tracker.ts', `
export type DetachedSkillTaskStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'blocked'
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /detached_status_copied_union/)
})

test('shared enum drift gate fails when required errorKind is unregistered', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/contracts/error-kinds.ts', `
export const DETACHED_TASK_ERROR_KINDS = {
  notFound: { code: 'detached_task_not_found' },
}
export const SEND_IM_ERROR_KINDS = {
  fileNotFound: { code: 'file_not_found' },
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /required_error_kind_unregistered/)
})

test('shared enum drift gate fails when detached failureKind copies a registered literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/skills/skill-task-tracker.ts', `
import { DETACHED_TASK_ERROR_KINDS } from '../contracts/error-kinds'
export const failureKind = 'detached_task_failed'
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when send-im errorKind copies a registered literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/send-im-skill-tool.ts', `
import { SEND_IM_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const output = { data: { errorKind: 'file_not_found' } }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when target-document errorKind is unregistered', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/contracts/error-kinds.ts', `
export const DETACHED_TASK_ERROR_KINDS = {
  taskFailed: { code: 'detached_task_failed' },
  notFound: { code: 'detached_task_not_found' },
  forbidden: { code: 'detached_task_forbidden' },
  runtimeUnavailable: { code: 'detached_task_runtime_unavailable' },
  skillActionUnknown: { code: 'detached_task_skill_action_unknown' },
  skillNotLoaded: { code: 'detached_task_skill_not_loaded' },
  hintRequired: { code: 'detached_task_hint_required' },
  visibilityInternal: { code: 'detached_task_visibility_internal' },
  startFailed: { code: 'detached_task_start_failed' },
}
export const SEND_IM_ERROR_KINDS = {
  blockedExternal: { code: 'blocked_external' },
  sendFailed: { code: 'send_failed' },
  sidecarUnavailable: { code: 'sidecar_unavailable' },
  channelNotReady: { code: 'channel_not_ready' },
  directoryNotSupported: { code: 'directory_not_supported' },
  fileNotFound: { code: 'file_not_found' },
  fileAmbiguous: { code: 'file_ambiguous' },
  intentNegated: { code: 'intent_negated' },
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /required_error_kind_unregistered/)
})

test('shared enum drift gate fails when target-document errorKind copies a registered literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts', `
import { TARGET_DOCUMENT_ERROR_KINDS } from '../contracts/error-kinds'
export const output = { data: { errorKind: 'target_document_required' } }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when browser tool errorKind is unregistered', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/contracts/error-kinds.ts', `
export const DETACHED_TASK_ERROR_KINDS = {
  taskFailed: { code: 'detached_task_failed' },
  notFound: { code: 'detached_task_not_found' },
  forbidden: { code: 'detached_task_forbidden' },
  runtimeUnavailable: { code: 'detached_task_runtime_unavailable' },
  skillActionUnknown: { code: 'detached_task_skill_action_unknown' },
  skillNotLoaded: { code: 'detached_task_skill_not_loaded' },
  hintRequired: { code: 'detached_task_hint_required' },
  visibilityInternal: { code: 'detached_task_visibility_internal' },
  startFailed: { code: 'detached_task_start_failed' },
}
export const SEND_IM_ERROR_KINDS = {
  blockedExternal: { code: 'blocked_external' },
  sendFailed: { code: 'send_failed' },
  sidecarUnavailable: { code: 'sidecar_unavailable' },
  channelNotReady: { code: 'channel_not_ready' },
  directoryNotSupported: { code: 'directory_not_supported' },
  fileNotFound: { code: 'file_not_found' },
  fileAmbiguous: { code: 'file_ambiguous' },
  intentNegated: { code: 'intent_negated' },
}
export const TARGET_DOCUMENT_ERROR_KINDS = {
  preservedContentMissing: { code: 'target_document_preserved_content_missing' },
  openUnavailable: { code: 'target_document_open_unavailable' },
  openFailed: { code: 'target_document_open_failed' },
  saveUnavailable: { code: 'target_document_save_unavailable' },
  saveFailed: { code: 'target_document_save_failed' },
  required: { code: 'target_document_required' },
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /required_error_kind_unregistered/)
})

test('shared enum drift gate fails when browser tool errorKind copies a registered literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/browser-failure-output.ts', `
import { BROWSER_TOOL_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const output = { data: { errorKind: 'browser_tool_failed' } }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when tool admission errorKind is unregistered', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/contracts/error-kinds.ts', `
export const DETACHED_TASK_ERROR_KINDS = {
  taskFailed: { code: 'detached_task_failed' },
  notFound: { code: 'detached_task_not_found' },
  forbidden: { code: 'detached_task_forbidden' },
  runtimeUnavailable: { code: 'detached_task_runtime_unavailable' },
  skillActionUnknown: { code: 'detached_task_skill_action_unknown' },
  skillNotLoaded: { code: 'detached_task_skill_not_loaded' },
  hintRequired: { code: 'detached_task_hint_required' },
  visibilityInternal: { code: 'detached_task_visibility_internal' },
  startFailed: { code: 'detached_task_start_failed' },
}
export const SEND_IM_ERROR_KINDS = {
  blockedExternal: { code: 'blocked_external' },
  sendFailed: { code: 'send_failed' },
  sidecarUnavailable: { code: 'sidecar_unavailable' },
  channelNotReady: { code: 'channel_not_ready' },
  directoryNotSupported: { code: 'directory_not_supported' },
  fileNotFound: { code: 'file_not_found' },
  fileAmbiguous: { code: 'file_ambiguous' },
  intentNegated: { code: 'intent_negated' },
}
export const TARGET_DOCUMENT_ERROR_KINDS = {
  preservedContentMissing: { code: 'target_document_preserved_content_missing' },
  openUnavailable: { code: 'target_document_open_unavailable' },
  openFailed: { code: 'target_document_open_failed' },
  saveUnavailable: { code: 'target_document_save_unavailable' },
  saveFailed: { code: 'target_document_save_failed' },
  required: { code: 'target_document_required' },
}
export const BROWSER_TOOL_ERROR_KINDS = {
  browserToolFailed: { code: 'browser_tool_failed' },
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /required_error_kind_unregistered/)
})

test('shared enum drift gate fails when tool-executor copies a tool admission literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/tool-executor.ts', `
import { TOOL_ADMISSION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const output = { data: { errorKind: 'authorization_denied' } }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when tool-runtime copies a tool admission literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/tools-runtime/tool-runtime.ts', `
import { TOOL_ADMISSION_ERROR_KINDS } from '../contracts/error-kinds'
export const output = { data: { errorKind: 'tool_restricted_this_turn' } }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when agent-sdk-runtime compares copied tool admission literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts', `
import { TOOL_ADMISSION_ERROR_KINDS } from '../contracts/error-kinds'
export const blocked = errorKind === 'tool_not_registered'
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when tool-result-envelope copies a tool admission literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/tool-result-envelope.ts', `
import { TOOL_ADMISSION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const map = { tool_not_registered: 'not_found' }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when action-confirmation errorKind is unregistered', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/contracts/error-kinds.ts', `
export const DETACHED_TASK_ERROR_KINDS = {
  taskFailed: { code: 'detached_task_failed' },
  notFound: { code: 'detached_task_not_found' },
  forbidden: { code: 'detached_task_forbidden' },
  runtimeUnavailable: { code: 'detached_task_runtime_unavailable' },
  skillActionUnknown: { code: 'detached_task_skill_action_unknown' },
  skillNotLoaded: { code: 'detached_task_skill_not_loaded' },
  hintRequired: { code: 'detached_task_hint_required' },
  visibilityInternal: { code: 'detached_task_visibility_internal' },
  startFailed: { code: 'detached_task_start_failed' },
}
export const SEND_IM_ERROR_KINDS = {
  blockedExternal: { code: 'blocked_external' },
  sendFailed: { code: 'send_failed' },
  sidecarUnavailable: { code: 'sidecar_unavailable' },
  channelNotReady: { code: 'channel_not_ready' },
  directoryNotSupported: { code: 'directory_not_supported' },
  fileNotFound: { code: 'file_not_found' },
  fileAmbiguous: { code: 'file_ambiguous' },
  intentNegated: { code: 'intent_negated' },
}
export const TARGET_DOCUMENT_ERROR_KINDS = {
  preservedContentMissing: { code: 'target_document_preserved_content_missing' },
  openUnavailable: { code: 'target_document_open_unavailable' },
  openFailed: { code: 'target_document_open_failed' },
  saveUnavailable: { code: 'target_document_save_unavailable' },
  saveFailed: { code: 'target_document_save_failed' },
  required: { code: 'target_document_required' },
}
export const BROWSER_TOOL_ERROR_KINDS = {
  browserToolFailed: { code: 'browser_tool_failed' },
}
export const TOOL_ADMISSION_ERROR_KINDS = {
  toolNotRegistered: { code: 'tool_not_registered' },
  authorizationDenied: { code: 'authorization_denied' },
  internalToolNotAllowed: { code: 'internal_tool_not_allowed' },
  toolRestrictedThisTurn: { code: 'tool_restricted_this_turn' },
  deniedByUserNegation: { code: 'denied_by_user_negation' },
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /required_error_kind_unregistered/)
})

test('shared enum drift gate fails when action-confirmation codes are registered in the wrong family', (t) => {
  const root = makeHarnessRoot(t)
  const registryPath = path.join(root, 'src/main/modules/agent-control/contracts/error-kinds.ts')
  const registry = fs.readFileSync(registryPath, 'utf8')
    .replace(
      'export const ACTION_CONFIRMATION_ERROR_KINDS =',
      'export const COPIED_ACTION_CONFIRMATION_ERROR_KINDS =',
    )
  fs.writeFileSync(registryPath, registry)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_family_missing/)
})

test('shared enum drift gate fails when tool-executor copies an action-confirmation literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/tool-executor.ts', `
import { ACTION_CONFIRMATION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export function bad(deniedOutput) { return deniedOutput('confirmation_expired', 'expired') }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when browser tools copy action-confirmation literals', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/browser-tools.ts', `
import { ACTION_CONFIRMATION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export function manual(ToolDomainError) { throw new ToolDomainError('denied_manual_only', 'manual') }
export function password(ToolDomainError) { throw new ToolDomainError('denied_pending_confirmation', 'password') }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when tool-result-envelope copies an action-confirmation object key', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/tool-result-envelope.ts', `
import { ACTION_CONFIRMATION_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const map = { denied_manual_only: 'denied_by_policy' }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when action-confirmation target misses registry import', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/browser-tools.ts', `
export const value = 'no action confirmation constants here'
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_registry_not_imported/)
})

test('shared enum drift gate fails when action-confirmation target uses the registry without importing it', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/browser-tools.ts', `
export const manualOnly = ACTION_CONFIRMATION_ERROR_KINDS.deniedManualOnly.code
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_registry_not_imported/)
})

test('shared enum drift gate fails when specialist blueprint codes are registered in the wrong family', (t) => {
  const root = makeHarnessRoot(t)
  const registryPath = path.join(root, 'src/main/modules/agent-control/contracts/error-kinds.ts')
  const registry = fs.readFileSync(registryPath, 'utf8')
    .replace(
      'export const SPECIALIST_BLUEPRINT_ERROR_KINDS =',
      'export const COPIED_SPECIALIST_BLUEPRINT_ERROR_KINDS =',
    )
  fs.writeFileSync(registryPath, registry)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_family_missing/)
})

test('shared enum drift gate fails when specialist blueprint target misses registry usage', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/builtins/propose-specialist-blueprint.ts', `
export const value = 'no specialist blueprint constants here'
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_registry_not_imported/)
})

test('shared enum drift gate fails when specialist blueprint target uses the registry without importing it', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/builtins/propose-specialist-blueprint.ts', `
export const output = SPECIALIST_BLUEPRINT_ERROR_KINDS.verbatimMismatch.code
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_registry_not_imported/)
})

test('shared enum drift gate fails when specialist blueprint imports registry from the wrong path', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/builtins/propose-specialist-blueprint.ts', `
import { SPECIALIST_BLUEPRINT_ERROR_KINDS } from '../../fake/contracts/error-kinds'
export const output = SPECIALIST_BLUEPRINT_ERROR_KINDS.verbatimMismatch.code
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_registry_not_imported/)
})

test('shared enum drift gate fails when specialist blueprint copies an errorKind property literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/builtins/propose-specialist-blueprint.ts', `
import { SPECIALIST_BLUEPRINT_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
export const output = { data: { errorKind: 'confirmed_blueprint_immutable' } }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when specialist blueprint copies a positional literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/builtins/propose-specialist-blueprint.ts', `
import { SPECIALIST_BLUEPRINT_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
export function bad(makeError) { return makeError('verbatim_mismatch') }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when specialist blueprint copies a type union literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/builtins/propose-specialist-blueprint.ts', `
import { SPECIALIST_BLUEPRINT_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
export type VerbatimFailure = 'verbatim_source_unavailable' | 'verbatim_mismatch'
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when specialist blueprint copies an object-map key', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/builtins/propose-specialist-blueprint.ts', `
import { SPECIALIST_BLUEPRINT_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
export const map = { verbatim_mismatch: 'bad' }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when web research codes are registered in the wrong family', (t) => {
  const root = makeHarnessRoot(t)
  const registryPath = path.join(root, 'src/main/modules/agent-control/contracts/error-kinds.ts')
  const registry = fs.readFileSync(registryPath, 'utf8')
    .replace(
      'export const WEB_RESEARCH_ERROR_KINDS =',
      'export const COPIED_WEB_RESEARCH_ERROR_KINDS =',
    )
  fs.writeFileSync(registryPath, registry)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_family_missing/)
})

test('shared enum drift gate fails when web search imports registry from the wrong path', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/builtins/web-search.ts', `
import { WEB_RESEARCH_ERROR_KINDS } from '../../fake/contracts/error-kinds'
export const failure = WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_registry_not_imported/)
})

test('shared enum drift gate fails when web search copies a local literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/builtins/web-search.ts', `
import { WEB_RESEARCH_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
export function bad(ToolDomainError) { throw new ToolDomainError('web_search_failed', 'failed') }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when web fetch copies a local literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/builtins/web-fetch.ts', `
import { WEB_RESEARCH_ERROR_KINDS } from '../../agent-control/contracts/error-kinds'
export function bad(ToolDomainError) { throw new ToolDomainError('web_fetch_failed', 'failed') }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when tool-result-envelope copies a web research object key', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/tool-result-envelope.ts', `
import { WEB_RESEARCH_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const map = { web_search_failed: 'upstream_error' }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when web_fetch_failed is not explicitly mapped', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/tool-result-envelope.ts', `
import { WEB_RESEARCH_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const map = {
  [WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code]: 'upstream_error',
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_envelope_mapping_missing/)
})

test('shared enum drift gate fails when any registered errorKind is missing from EXPLICIT_KIND_MAP', (t) => {
  const root = makeHarnessRoot(t)
  const rel = 'src/main/modules/tools/tool-result-envelope.ts'
  const abs = path.join(root, rel)
  const text = fs.readFileSync(abs, 'utf8')
  fs.writeFileSync(abs, text.replace("  provider_request_failed: 'upstream_error',\n", ''))
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /provider_request_failed is registered/)
})

test('shared enum drift gate fails when provider codes are registered in the wrong family', (t) => {
  const root = makeHarnessRoot(t)
  const registryPath = path.join(root, 'src/main/modules/agent-control/contracts/error-kinds.ts')
  const registry = fs.readFileSync(registryPath, 'utf8')
    .replace(
      'export const PROVIDER_ERROR_KINDS =',
      'export const COPIED_PROVIDER_ERROR_KINDS =',
    )
  fs.writeFileSync(registryPath, registry)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_family_missing/)
})

test('shared enum drift gate fails when provider target imports registry from the wrong path', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/claude-bridge/llm-resilience.ts', `
import { PROVIDER_ERROR_KINDS } from '../fake/contracts/error-kinds'
export const classification = { errorKind: PROVIDER_ERROR_KINDS.providerThinkingEchoRequired.code }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_registry_not_imported/)
})

test('shared enum drift gate fails when provider producer copies a local literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/agent-control/thinking-compatibility.ts', `
import { PROVIDER_ERROR_KINDS } from './contracts/error-kinds'
export const registry = PROVIDER_ERROR_KINDS.providerRequestFailed.code
export function fail(ToolDomainError) { throw new ToolDomainError('provider_request_failed', 'blocked') }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when provider consumer set copies a local literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/claude-bridge/error-contract.ts', `
import { PROVIDER_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const registry = PROVIDER_ERROR_KINDS.providerRequestFailed.code
export const terminalKinds = new Set(['provider_request_failed'])
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when mcp tool codes are registered in the wrong family', (t) => {
  const root = makeHarnessRoot(t)
  const registryPath = path.join(root, 'src/main/modules/agent-control/contracts/error-kinds.ts')
  const registry = fs.readFileSync(registryPath, 'utf8')
    .replace(
      'export const MCP_TOOL_ERROR_KINDS =',
      'export const COPIED_MCP_TOOL_ERROR_KINDS =',
    )
  fs.writeFileSync(registryPath, registry)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_family_missing/)
})

test('shared enum drift gate fails when mcp tools import registry from the wrong path', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/mcp-tools.ts', `
import { MCP_TOOL_ERROR_KINDS } from '../fake/contracts/error-kinds'
export const failure = MCP_TOOL_ERROR_KINDS.authorizationDenied.code
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_registry_not_imported/)
})

test('shared enum drift gate fails when mcp tools copy a local literal', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/mcp-tools.ts', `
import { MCP_TOOL_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export function bad(ToolDomainError) { throw new ToolDomainError('mcp_authorization_denied', 'denied') }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when tool-result-envelope copies an mcp object key', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/tool-result-envelope.ts', `
import { MCP_TOOL_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const map = { mcp_tool_unregistered: 'not_found' }
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /local_error_kind_literal/)
})

test('shared enum drift gate fails when mcp_authorization_denied is not explicitly mapped', (t) => {
  const root = makeHarnessRoot(t)
  writeFile(root, 'src/main/modules/tools/tool-result-envelope.ts', `
import { MCP_TOOL_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
export const map = {
  [MCP_TOOL_ERROR_KINDS.toolUnregistered.code]: 'not_found',
  [MCP_TOOL_ERROR_KINDS.clientMissing.code]: 'upstream_error',
  [MCP_TOOL_ERROR_KINDS.toolFailed.code]: 'upstream_error',
}
`)
  const result = runIn(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /error_kind_envelope_mapping_missing/)
})
