import type { PrePersistenceErrorKind } from '../../../../shared/ipc-contracts/agent-runtime'
import { PrePersistenceAdmissionError } from '../send-scoped-confirmation'

export type CodexIngressPreparationFailure = {
  code: PrePersistenceErrorKind
  retryableByUser: boolean
  error: string
}

function stableCode(error: unknown): string {
  const candidates = [
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null,
    error instanceof Error ? error.message : error,
  ]
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim() : ''
    if (/^[a-z0-9_:-]{1,128}$/i.test(value)) return value
  }
  return 'codex_ingress_preparation_failed'
}

const CONFIGURATION_CODES = new Set([
  'codex_active_profile_missing',
  'codex_chatgpt_oauth_configuration_invalid',
  'codex_chatgpt_oauth_not_connected',
  'codex_external_read_lark_auth_required',
  'codex_selected_skill_unavailable',
  'codex_selected_skill_methodology_unavailable',
  'gateway_agent_protocol_unsupported',
  'gateway_context_window_invalid',
  'gateway_profile_id_invalid',
  'gateway_provider_not_found',
  'gateway_reasoning_capability_unsupported',
  'gateway_reasoning_policy_unsupported',
  'gateway_retry_policy_invalid',
  'gateway_upstream_model_invalid',
  'gateway_upstream_url_invalid',
  'gateway_wire_api_unsupported',
])

const ATTACHMENT_CODES = new Set([
  'codex_explicit_resource_kind_mismatch',
  'codex_explicit_resource_unavailable',
  'codex_explicit_resource_unsupported',
  'codex_explicit_mcp_resource_unavailable',
  'codex_explicit_retry_destination_identity_drift',
  'codex_explicit_retry_resource_identity_drift',
  'codex_explicit_skill_not_directory',
  'codex_explicit_skill_unavailable',
  'codex_external_read_slice_conflicts_with_current_document',
  'codex_external_read_slice_digest_invalid',
  'codex_external_read_slice_invalid',
  'codex_external_read_slice_preparation_invalid',
  'codex_external_read_slice_resource_policy_invalid',
  'codex_external_read_slice_tool_policy_invalid',
  'codex_product_ingress_unsupported',
])

const EXTERNAL_SERVICE_CODES = new Set([
  'codex_chatgpt_oauth_lifecycle_busy',
  'codex_chatgpt_oauth_runtime_unavailable',
  'codex_external_read_feishu_unavailable',
  'codex_external_read_lark_cli_unavailable',
  'codex_external_read_lark_resources_unavailable',
])

const CAPABILITY_CODES = new Set([
  'tool_surface_result_state_unsupported',
  'tool_surface_skill_execution_unsupported',
  'tool_surface_empty',
  'tool_surface_schema_compaction_unsupported',
])

export function classifyCodexIngressPreparationError(
  error: unknown,
): CodexIngressPreparationFailure {
  if (error instanceof PrePersistenceAdmissionError) {
    return {
      code: error.code,
      retryableByUser: error.retryableByUser,
      error: stableCode(error.message),
    }
  }
  const internalCode = stableCode(error)
  if (CONFIGURATION_CODES.has(internalCode)) {
    return { code: 'configuration_unavailable', retryableByUser: true, error: internalCode }
  }
  if (ATTACHMENT_CODES.has(internalCode)) {
    return { code: 'attachment_unavailable', retryableByUser: true, error: internalCode }
  }
  if (EXTERNAL_SERVICE_CODES.has(internalCode)) {
    return { code: 'external_service_unavailable', retryableByUser: true, error: internalCode }
  }
  if (CAPABILITY_CODES.has(internalCode)) {
    return { code: 'capability_unavailable', retryableByUser: true, error: internalCode }
  }
  if (
    internalCode === 'codex_conversation_materializing'
  ) {
    return { code: 'conversation_materializing', retryableByUser: true, error: internalCode }
  }
  if (
    internalCode === 'codex_alias_generation_mismatch'
    || internalCode === 'codex_alias_binding_missing'
    || internalCode === 'codex_conversation_reset_required'
    || /_requires_new_thread$/.test(internalCode)
    || /_requires_new_generation$/.test(internalCode)
  ) {
    return { code: 'conversation_reset_required', retryableByUser: false, error: internalCode }
  }
  return { code: 'host_unavailable', retryableByUser: true, error: internalCode }
}
