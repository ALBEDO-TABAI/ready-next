/**
 * Tool dispatch error contract (Phase 1 of tool-error refactor).
 *
 * Pins three behaviors:
 * 1. A bare `throw new Error(...)` from a handler does NOT escape executeToolCall.
 *    It becomes a structured ToolExecutionOutput with errorKind='tool_handler_failure'
 *    so the model receives it as a recoverable tool_result and can adapt.
 * 2. A ToolDomainError preserves its errorKind + detail in the structured result.
 * 3. Terminal infrastructure errors (AbortError, ToolHostUnavailableError) still
 *    bubble past executeToolCall so the outer runtime can cancel remaining work.
 *
 * We do not import executeToolCall directly — doing so pulls in Electron via
 * skills-runtime > database. Instead we verify the dispatch contract through
 * a source-level inspection (the catch block shape + imports) plus a direct
 * unit test of tool-errors.ts helpers.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  ToolAbortError,
  ToolDomainError,
  ToolHostUnavailableError,
  errorKindFor,
  errorMessageOf,
  isTerminalInfrastructureError,
} from '../main/modules/tools/tool-errors'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('ToolDomainError carries errorKind and optional structured detail', () => {
  const error = new ToolDomainError('widget_not_found', 'Widget w-1 does not exist', { widgetId: 'w-1' })
  assert.equal(error.name, 'ToolDomainError')
  assert.equal(error.errorKind, 'widget_not_found')
  assert.deepEqual(error.detail, { widgetId: 'w-1' })
  assert.equal(errorKindFor(error), 'widget_not_found')
  assert.equal(errorMessageOf(error), 'Widget w-1 does not exist')
})

test('ToolHostUnavailableError is a terminal infrastructure error', () => {
  const error = new ToolHostUnavailableError('browser_click', 'Browser controller is not available')
  assert.equal(isTerminalInfrastructureError(error), true)
  assert.equal(errorKindFor(error), 'host_unavailable')
})

test('ToolAbortError and any Error named AbortError is terminal', () => {
  assert.equal(isTerminalInfrastructureError(new ToolAbortError()), true)
  const legacyAbort = new Error('Operation aborted')
  legacyAbort.name = 'AbortError'
  assert.equal(isTerminalInfrastructureError(legacyAbort), true)
  assert.equal(errorKindFor(legacyAbort), 'aborted')
})

test('A bare Error is not terminal and falls back to tool_handler_failure', () => {
  const error = new Error('something broke')
  assert.equal(isTerminalInfrastructureError(error), false)
  assert.equal(errorKindFor(error), 'tool_handler_failure')
})

test('A non-Error thrown value still returns a safe errorKind and message', () => {
  assert.equal(errorKindFor('plain string throw'), 'tool_handler_failure')
  assert.equal(errorMessageOf('plain string throw'), 'plain string throw')
})

test('executeToolCall wraps handler throws into structured ToolExecutionOutput', () => {
  const source = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')

  // Imports the error contract helpers.
  assert.match(source, /from ['"]\.\/tool-errors['"]/)
  assert.match(source, /isTerminalInfrastructureError/)
  assert.match(source, /errorKindFor/)

  // Outer try/catch exists on the dispatch path.
  assert.match(source, /try \{[\s\S]*switch \(definition\.domain\)[\s\S]*catch \(error\)/)

  // Terminal errors still rethrow; non-terminal become structured outputs.
  assert.match(source, /if \(isTerminalInfrastructureError\(error\)\) \{[\s\S]*throw error[\s\S]*\}/)
  // Phase 4: the hardcoded string was swapped for TOOL_ERROR_METRICS.surfaced.
  // Either form acceptable; what we actually want to pin is that a surfaced
  // metric is emitted with errorKind carried forward.
  assert.match(source, /logAgentMetric\((?:'tool_error_surfaced'|TOOL_ERROR_METRICS\.surfaced)/)
  assert.match(source, /errorKind:\s*kind/)
})

test('tool-runtime no longer rethrows on unknown-kind errors', () => {
  const source = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-runtime.ts')

  // Terminal infra guard exists.
  assert.match(source, /if \(isTerminalInfrastructureError\(error\)\) \{\s*throw error\s*\}/)

  // The legacy `throw error` tail after the classifier is gone.
  assert.doesNotMatch(source, /\n\s{8}throw error\n\s{6}\} finally \{/)

  // Unknown-kind errors log a metric before being surfaced. Phase 4 swapped
  // the hardcoded string for TOOL_ERROR_METRICS.unknownSurfaced.
  assert.match(source, /logAgentMetric\((?:'tool_error_unknown_surfaced'|TOOL_ERROR_METRICS\.unknownSurfaced)/)

  // Import added.
  assert.match(source, /from ['"]\.\.\/\.\.\/tools\/tool-errors['"]/)
})

test('tool-executor runs Zod validator for every tool domain via the unified registry', () => {
  const source = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')

  // Validator wiring — `validateToolInput` is the unified entry.
  assert.match(source, /from ['"]\.\/tool-input-validator['"]/)

  // Schema source — `resolveToolInputSchemaForExecution` is the registry's
  // unified per-tool resolver. It internally consults `getToolInputSchemas()`
  // (static) and falls back to the dynamic skill-action cache, so this single
  // entry preserves the "unified registry, not skill-only map" invariant
  // even after the pet feature switched from a wholesale `getToolInputSchemas()`
  // map import to per-tool resolution.
  assert.match(
    source,
    /resolveToolInputSchemaForExecution[\s\S]*from ['"]\.\.\/agent-control\/tools-runtime\/tool-registry['"]/,
    'tool-executor must import resolveToolInputSchemaForExecution from the unified registry',
  )
  assert.match(
    source,
    /resolveToolInputSchemaForExecution\(toolName\)/,
    'tool-executor must resolve schema per-tool via the unified registry resolver',
  )

  // Phase 2.5: gate is domain-agnostic. The old skill-only guard must be gone
  // so other domains don't silently skip validation.
  assert.doesNotMatch(source, /if \(definition\.domain === ['"]skill['"]\) \{\s*const outcome = validateToolInput/)

  // validateToolInput is invoked with a per-tool schema map. Either the
  // historical wholesale form (`getToolInputSchemas()`) or the per-tool
  // form built from `resolveToolInputSchemaForExecution` is acceptable —
  // both preserve the unified-registry invariant.
  assert.match(
    source,
    /validateToolInput\(toolName, args,\s*(?:getToolInputSchemas\(\)|mergedSchemas|schemas)\)/,
  )

  // Metric payload carries the domain so per-domain failure rates can be split.
  // Phase 4 swapped the literal for TOOL_ERROR_METRICS.inputValidation; accept either.
  assert.match(source, /logAgentMetric\((?:['"]tool_input_validation_failed['"]|TOOL_ERROR_METRICS\.inputValidation)/)
  assert.match(source, /domain:\s*definition\.domain/)
  assert.match(source, /return outcome\.output/)

  // On success, parsed data replaces raw args so coercion takes effect.
  assert.match(source, /args = outcome\.data/)
})

// =============================================================================
// Stage 4 W0 — Contract pinning for authorization layer (W3 protection)
// =============================================================================
// W3 will add `authorization_denied` errorKind for skill_* tools where
// SkillToolAuthorization rejects them in admission. The new errorKind is
// distinct from `tool_not_registered` (fabricated tool name; registry signal)
// and `tool_restricted_this_turn` (preflight allowedToolNames signal).
// These tests pin the existing two-channel structure so W3's third channel
// is purely additive — no errorKind reuse / no contract collapse.

test('Stage U U1.1: tool-executor returns errorKind:tool_not_registered (top-level) for unregistered tool name — distinct from authorization_denied', () => {

  const source = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  // Stage U U1.1 promoted `tool_not_registered` from nested `reason` to top-level
  // `errorKind`. AGENTS.md §3 requires mutual exclusivity with `authorization_denied`.
  assert.match(
    source,
    /errorKind: 'tool_not_registered'/,
    'tool_not_registered must be the top-level errorKind for fabricated tool names (U1.1)',
  )
  // The registration check ordering comment must remain (it documents the contract).
  assert.match(
    source,
    /Check registration BEFORE admission/,
    'Registration-before-admission ordering documentation must remain',
  )
})

test('Stage 4 W0: tool-runtime preflight rejects unallowed tools as tool_restricted_this_turn — W3 will skip skill_* but keep this for non-skill', () => {
   
  const source = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-runtime.ts')
  assert.match(
    source,
    /reason: 'tool_restricted_this_turn'/,
    'tool-runtime preflight must keep tool_restricted_this_turn errorKind for non-skill tools after W3',
  )
  assert.match(
    source,
    /allowedToolNames\?\.has\(toolName\)/,
    'preflight allowedToolNames check must remain — W3 will only change its applicability scope (skip skill_* prefix)',
  )
})
