import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyCodexIngressPreparationError,
} from '../main/modules/agent-control/codex-runtime/codex-ingress-preparation-error'
import {
  CodexModelGatewayContractError,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'

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
