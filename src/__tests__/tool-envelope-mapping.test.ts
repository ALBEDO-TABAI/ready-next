import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildErrorEnvelope,
  buildOkEnvelope,
  mapErrorKindToEnvelopeKind,
  type ToolEnvelopeKind,
} from '../main/modules/tools/tool-result-envelope'

// Every errorKind literal present in HEAD (harvested from tool-errors.ts +
// tools/ + agent-control/). Each must map explicitly (mapped === true) to the
// expected action-oriented kind. This is the "穷举" guarantee.
const EXPECTED: Record<string, ToolEnvelopeKind> = {
  input_validation: 'arg_error',
  command_empty: 'arg_error',
  command_parse_failed: 'arg_error',
  config_patch_invalid_pointer: 'arg_error',
  no_payload: 'arg_error',
  target_document_required: 'arg_error',
  scope_missing: 'arg_error',
  clip_login_required: 'auth_expired',
  decrypt_unavailable: 'auth_expired',
  queued_global_concurrency: 'rate_limited',
  not_found: 'not_found',
  no_record: 'not_found',
  widget_not_found: 'not_found',
  tool_not_registered: 'not_found',
  mcp_tool_unregistered: 'not_found',
  no_driver_registered: 'not_found',
  host_unavailable: 'upstream_error',
  mcp_tool_failed: 'upstream_error',
  web_search_failed: 'upstream_error',
  driver_init_failed: 'upstream_error',
  launch_stuck: 'upstream_error',
  timeout: 'network_error',
  authorization_denied: 'denied_by_policy',
  tool_restricted_this_turn: 'denied_by_policy',
  command_high_risk_blocked: 'denied_by_policy',
  denied_manual_only: 'denied_by_policy',
  denied_pending_confirmation: 'denied_by_policy',
  confirmation_denied_by_user: 'denied_by_policy',
  confirmation_expired: 'denied_by_policy',
  path_outside_outputs: 'denied_by_policy',
  blocked_external: 'denied_by_policy',
  tool_handler_failure: 'internal_error',
  tool_failed: 'internal_error',
  runner_uncaught: 'internal_error',
  persistence_failed: 'internal_error',
  aborted: 'internal_error',
  process_restarted: 'internal_error',
}

test('every HEAD errorKind maps explicitly to its action-oriented kind', () => {
  for (const [errorKind, expected] of Object.entries(EXPECTED)) {
    const result = mapErrorKindToEnvelopeKind(errorKind)
    assert.equal(result.kind, expected, `${errorKind} → ${result.kind}, expected ${expected}`)
    assert.equal(result.mapped, true, `${errorKind} should be explicitly mapped`)
  }
})

test('unknown errorKind falls back to internal_error with mapped=false (warn signal)', () => {
  const result = mapErrorKindToEnvelopeKind('totally_novel_kind_xyz')
  assert.equal(result.kind, 'internal_error')
  assert.equal(result.mapped, false)
})

test('pattern fallback catches a never-seen-but-recognizable kind as mapped', () => {
  const r1 = mapErrorKindToEnvelopeKind('some_new_validation_problem')
  assert.equal(r1.kind, 'arg_error')
  assert.equal(r1.mapped, true)
  const r2 = mapErrorKindToEnvelopeKind('downstream_timeout_xyz')
  assert.equal(r2.kind, 'network_error')
  assert.equal(r2.mapped, true)
})

test('ok envelope omits error and carries data', () => {
  const env = buildOkEnvelope({ rows: 3 }, { elapsedMs: 12 })
  assert.equal(env.ok, true)
  assert.equal(env.kind, 'ok')
  assert.deepEqual(env.data, { rows: 3 })
  assert.equal(env.error, undefined)
  assert.equal(env.meta?.elapsedMs, 12)
})

test('error envelope carries kind, message, hint, retryAfterSec', () => {
  const env = buildErrorEnvelope({
    errorKind: 'input_validation',
    message: 'bad arg',
    hint: 're-read schema',
    retryAfterSec: 0,
  })
  assert.equal(env.ok, false)
  assert.equal(env.kind, 'arg_error')
  assert.equal(env.error?.message, 'bad arg')
  assert.equal(env.error?.hint, 're-read schema')
  assert.equal(env.error?.retryAfterSec, 0)
})
