import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyCodexIngressPreparationError,
} from '../main/modules/agent-control/codex-runtime/codex-ingress-preparation-error'
import {
  CodexModelGatewayContractError,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { PrePersistenceAdmissionError } from '../main/modules/agent-control/send-scoped-confirmation'

test('typed admission errors retain their public kind, retryability, and safe internal reason', () => {
  for (const [code, retryable, reason] of [
    ['conversation_reset_required', false, 'codex_action_admission_ref_stale'],
    ['thread_busy', true, 'codex_thread_busy'],
    ['conversation_materializing', true, 'codex_conversation_materializing'],
  ] as const) {
    assert.deepEqual(classifyCodexIngressPreparationError(
      new PrePersistenceAdmissionError(code, retryable, 'evidence', reason),
    ), { code, retryableByUser: retryable, error: reason })
  }
  assert.deepEqual(classifyCodexIngressPreparationError(
    new PrePersistenceAdmissionError('conversation_reset_required', false, 'evidence', 'Bearer secret'),
  ), {
    code: 'conversation_reset_required',
    retryableByUser: false,
    error: 'codex_ingress_preparation_failed',
  })
})

test('Codex ingress preparation distinguishes configuration, resources, external service, and host failures', () => {
  assert.deepEqual(
    classifyCodexIngressPreparationError(new Error('codex_active_profile_missing')),
    {
      code: 'configuration_unavailable',
      retryableByUser: true,
      error: 'codex_active_profile_missing',
    },
  )
  assert.deepEqual(
    classifyCodexIngressPreparationError(
      new CodexModelGatewayContractError('gateway_reasoning_policy_unsupported'),
    ),
    {
      code: 'configuration_unavailable',
      retryableByUser: true,
      error: 'gateway_reasoning_policy_unsupported',
    },
  )
  assert.equal(
    classifyCodexIngressPreparationError(
      new Error('codex_external_read_slice_resource_policy_invalid'),
    ).code,
    'attachment_unavailable',
  )
  for (const code of [
    'codex_explicit_retry_resource_identity_drift',
    'codex_explicit_retry_destination_identity_drift',
  ]) {
    assert.equal(
      classifyCodexIngressPreparationError(new Error(code)).code,
      'attachment_unavailable',
    )
  }
  assert.equal(
    classifyCodexIngressPreparationError(
      new Error('codex_external_read_feishu_unavailable'),
    ).code,
    'external_service_unavailable',
  )
  assert.deepEqual(
    classifyCodexIngressPreparationError(new Error('codex_alias_generation_mismatch')),
    {
      code: 'conversation_reset_required',
      retryableByUser: false,
      error: 'codex_alias_generation_mismatch',
    },
  )
  assert.equal(
    classifyCodexIngressPreparationError(new Error('codex_runtime_host_unbound')).code,
    'host_unavailable',
  )
  assert.deepEqual(
    classifyCodexIngressPreparationError(new Error('tool_surface_result_state_unsupported')),
    {
      code: 'capability_unavailable',
      retryableByUser: true,
      error: 'tool_surface_result_state_unsupported',
    },
  )
  for (const code of [
    'tool_surface_change_requires_new_thread',
    'model_change_requires_new_thread',
    'thread_contract_change_requires_new_thread',
    'native_thread_config_change_requires_new_generation',
  ]) {
    assert.deepEqual(
      classifyCodexIngressPreparationError(new Error(code)),
      {
        code: 'conversation_reset_required',
        retryableByUser: false,
        error: code,
      },
    )
  }
})

test('Codex ingress preparation never exposes free-form or secret-bearing errors', () => {
  assert.deepEqual(
    classifyCodexIngressPreparationError(new Error('Bearer secret should not escape')),
    {
      code: 'host_unavailable',
      retryableByUser: true,
      error: 'codex_ingress_preparation_failed',
    },
  )
})
