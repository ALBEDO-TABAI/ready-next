/**
 * Phase 4 — TOOL_ERROR_METRICS registry shape test.
 *
 * Locks:
 *   - documented entries exist (count grows only when a new metric is added
 *     and registered here alongside the emit site)
 *   - values are snake_case strings (match log-query grep conventions)
 *   - values are all distinct (no accidental reuse)
 *   - values match the historical metric strings so existing log queries
 *     continue working
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'

test('registry exposes documented tool-error metric keys', () => {
  const keys = Object.keys(TOOL_ERROR_METRICS).sort()
  assert.deepEqual(keys, [
    'askUserQuestionsCancelPersistFailed',
    'askUserQuestionsSubmitDbFailed',
    'askUserQuestionsSubmitResolverMissed',
    'authorizationDenied',
    'childResumeDisabledByFlag',
    'childRunCircuitBreak',
    'childRunLogGc',
    'childRunnerLifecycleWriteFailed',
    'confirmationGateDenied',
    'directToolCallTextBlocked',
    'domainToolNarrowingApplied',
    'hookHandlerFailed',
    'hookHandlerTimeout',
    'hookHandlerTimeoutWithUnknownOutcome',
    'inputValidation',
    'metaParseCorrupted',
    'outputDirGc',
    'outputDirSweepFailed',
    'providerArgumentsCorrupt',
    'providerRequestImageBlockedAtAttach',
    'providerThinkingEchoRequired400',
    'providerThinkingEchoUnsupported',
    'resolutionViolation',
    'runStateSchemaInvalid',
    'runStateSelectionDirSkipped',
    'secretDecryptFailed',
    'sessionRecallAutoAttached',
    'skillPrimitiveRejected',
    'skillPrimitiveUsed',
    'skillProjectionPartial',
    'skillReferenceHintRecoveredFromCapsule',
    'skillReferenceHintTtlSwept',
    'skillReferenceInlineFailed',
    'subagentCleanupDrainFailed',
    'surfaced',
    'systemReminderSuppressedByConflict',
    'toolCallTextIntercepted',
    'toolSnapshotMismatch',
    'unknownSurfaced',
    'userNegationDenied',
    'widgetBoundaryViolation',
    'xmlToolCallsRecoveredFromNative',
  ])
})

test('each value is a snake_case string', () => {
  for (const value of Object.values(TOOL_ERROR_METRICS)) {
    assert.equal(typeof value, 'string')
    assert.match(value, /^[a-z][a-z0-9_]*$/)
  }
})

test('values are all distinct', () => {
  const values = Object.values(TOOL_ERROR_METRICS)
  assert.equal(new Set(values).size, values.length)
})

test('historical metric strings are preserved (log-compat contract)', () => {
  // Renaming these breaks log aggregation queries. If you change a value on
  // purpose, document the rename in CHANGELOG.md and bump this assertion.
  assert.equal(TOOL_ERROR_METRICS.surfaced, 'tool_error_surfaced')
  assert.equal(TOOL_ERROR_METRICS.unknownSurfaced, 'tool_error_unknown_surfaced')
  assert.equal(TOOL_ERROR_METRICS.inputValidation, 'tool_input_validation_failed')
  assert.equal(TOOL_ERROR_METRICS.resolutionViolation, 'tool_resolution_violation_post_arbitration')
  // Phase 4: skillExecutionMissing + ttlSwept retired alongside the
  // skill_executions state machine. Reference-hint sweep gets its own metric.
  assert.equal(TOOL_ERROR_METRICS.skillReferenceHintTtlSwept, 'skill_reference_hint_ttl_swept')
  assert.equal(TOOL_ERROR_METRICS.toolSnapshotMismatch, 'tool_snapshot_mismatch')
  // B Phase 1 — skill primitives
  assert.equal(TOOL_ERROR_METRICS.skillPrimitiveUsed, 'skill_primitive_used')
  assert.equal(TOOL_ERROR_METRICS.skillPrimitiveRejected, 'skill_primitive_rejected')
  // Domain adapter prefix narrowing (post-Phase 4 telemetry)
  assert.equal(TOOL_ERROR_METRICS.domainToolNarrowingApplied, 'domain_tool_narrowing_applied')
  // skill-resume E1 — auto-attach historical recall capsules on retry intent
  assert.equal(TOOL_ERROR_METRICS.sessionRecallAutoAttached, 'session_recall_auto_attached')
  // skill-resume G4 — last-recourse hint recovery from auto-attached capsule text
  assert.equal(TOOL_ERROR_METRICS.skillReferenceHintRecoveredFromCapsule, 'skill_reference_hint_recovered_from_capsule')
  // Stage 2.1a — provider-side malformed tool_calls.arguments
  assert.equal(TOOL_ERROR_METRICS.providerArgumentsCorrupt, 'provider_arguments_corrupt')
  assert.equal(TOOL_ERROR_METRICS.directToolCallTextBlocked, 'direct_tool_call_text_blocked')
  // Stage 4 W3 — model-issued skill_* tool blocked by per-turn authorization
  assert.equal(TOOL_ERROR_METRICS.authorizationDenied, 'authorization_denied')
  // A1 SubAgent skeleton — lifecycle cleanup drain failure observability
  assert.equal(TOOL_ERROR_METRICS.subagentCleanupDrainFailed, 'subagent_cleanup_drain_failed')
  // H1 — previously silent fallback paths now emit observability.
  assert.equal(TOOL_ERROR_METRICS.secretDecryptFailed, 'secret_decrypt_failed')
  assert.equal(TOOL_ERROR_METRICS.skillReferenceInlineFailed, 'skill_reference_inline_failed')
  assert.equal(TOOL_ERROR_METRICS.skillProjectionPartial, 'skill_projection_partial')
  assert.equal(TOOL_ERROR_METRICS.runStateSelectionDirSkipped, 'run_state_selection_dir_skipped')
  assert.equal(TOOL_ERROR_METRICS.runStateSchemaInvalid, 'run_state_schema_invalid')
  // Stage U (PR 1) — ask_user_questions submit / cancel chain diagnostics.
  assert.equal(TOOL_ERROR_METRICS.askUserQuestionsSubmitDbFailed, 'ask_user_questions_submit_db_failed')
  assert.equal(TOOL_ERROR_METRICS.askUserQuestionsSubmitResolverMissed, 'ask_user_questions_submit_resolver_missed')
  assert.equal(TOOL_ERROR_METRICS.askUserQuestionsCancelPersistFailed, 'ask_user_questions_cancel_persist_failed')
  assert.equal(TOOL_ERROR_METRICS.providerThinkingEchoUnsupported, 'provider_thinking_echo_unsupported')
  assert.equal(TOOL_ERROR_METRICS.providerThinkingEchoRequired400, 'provider_thinking_echo_required_400')
  assert.equal(TOOL_ERROR_METRICS.providerRequestImageBlockedAtAttach, 'provider_request_image_blocked_at_attach')
})
