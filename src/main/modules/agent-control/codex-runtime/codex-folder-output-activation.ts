import type { DatabaseConnection } from '../../database/connection'

export const CODEX_FOLDER_DELIVERY_TOOL_NAMES = Object.freeze([
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_export_artifact',
] as const)

export type CodexFolderOutputActivation =
  | Readonly<{ kind: 'no_contract' | 'selection_required' | 'pending' }>
  | Readonly<{
      kind: 'positive'
      destinationResourceId: string
      expectedOutputs: readonly string[]
      declarationActionId: string
      declarationReceiptId: string
      declarationResultDigest: string
      deliveryAttemptId: string
    }>
  | Readonly<{
      kind: 'no_write'
      destinationResourceId: string
      declarationActionId: string
      declarationReceiptId: string
      declarationResultDigest: string
      deliveryAttemptId: string
    }>

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function outputContractState(ingressJson: string | null): {
  destinationResourceId: string | null
  directoryCount: number
} {
  if (!ingressJson) return { destinationResourceId: null, directoryCount: 0 }
  try {
    const ingress = JSON.parse(ingressJson) as unknown
    if (!record(ingress) || !record(ingress.prepared)) {
      return { destinationResourceId: null, directoryCount: 0 }
    }
    const directoryCount = Array.isArray(ingress.prepared.resourceAuthorities)
      ? ingress.prepared.resourceAuthorities.filter(
          (authority) => record(authority) && authority.kind === 'local_directory',
        ).length
      : 0
    const contract = record(ingress.prepared.outputContract)
      ? ingress.prepared.outputContract
      : null
    const destination = contract && record(contract.destination) ? contract.destination : null
    const id = destination?.logicalResourceId
    return {
      destinationResourceId: typeof id === 'string' && id.trim() ? id : null,
      directoryCount,
    }
  } catch {
    return { destinationResourceId: null, directoryCount: 0 }
  }
}

export function readCodexFolderOutputActivation(
  db: DatabaseConnection,
  readyRunId: string,
): CodexFolderOutputActivation {
  const turn = db.prepare(`
    SELECT ingress_json FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
  `).get<{ ingress_json: string | null }>(readyRunId)
  const contractState = outputContractState(turn?.ingress_json ?? null)
  const destinationResourceId = contractState.destinationResourceId
  if (!destinationResourceId && contractState.directoryCount > 1) {
    return { kind: 'selection_required' }
  }
  if (!destinationResourceId) return { kind: 'no_contract' }
  const rows = db.prepare(`
    SELECT binding.ready_action_id,
           action.receipt_id,
           action.result_digest,
           action.result_json,
           delivery.attempt_id
      FROM codex_tool_call_bindings binding
      JOIN ready_tool_action_receipts action
        ON action.ready_action_id = binding.ready_action_id
       AND action.state = 'confirmed'
      JOIN codex_tool_response_delivery_attempts delivery
        ON delivery.ready_action_id = binding.ready_action_id
       AND delivery.transport_write_confirmed_at IS NOT NULL
     WHERE binding.ready_run_id = ?
       AND binding.tool_name = 'declare_completion_criteria'
     ORDER BY binding.created_at ASC, binding.ready_action_id ASC, delivery.created_at ASC
  `).all<{
    ready_action_id: string
    receipt_id: string
    result_digest: string
    result_json: string
    attempt_id: string
  }>(readyRunId)
  if (rows.length === 0) return { kind: 'pending' }
  const first = rows[0]
  let result: unknown
  try {
    result = JSON.parse(first.result_json)
  } catch {
    return { kind: 'pending' }
  }
  if (!record(result) || !record(result.data)
    || result.data.destinationResourceId !== destinationResourceId) return { kind: 'pending' }
  const intent = result.data.folderOutputIntent
  const base = {
    destinationResourceId,
    declarationActionId: first.ready_action_id,
    declarationReceiptId: first.receipt_id,
    declarationResultDigest: first.result_digest,
    deliveryAttemptId: first.attempt_id,
  }
  if (intent === 'no_write') return { kind: 'no_write', ...base }
  if (!['create', 'save', 'export'].includes(String(intent))) return { kind: 'pending' }
  const expectedOutputs = result.data.expectedOutputs
  if (!Array.isArray(expectedOutputs) || expectedOutputs.length === 0
    || expectedOutputs.length > 8
    || expectedOutputs.some((value) => typeof value !== 'string' || !value.trim())) {
    return { kind: 'pending' }
  }
  return Object.freeze({ kind: 'positive', ...base, expectedOutputs: Object.freeze([...expectedOutputs]) })
}

export function effectiveCodexFolderOutputToolNames(
  frozenAllowedToolNames: readonly string[],
  activation: CodexFolderOutputActivation,
): string[] {
  const deliveryNames = new Set<string>(CODEX_FOLDER_DELIVERY_TOOL_NAMES)
  const withoutDelivery = frozenAllowedToolNames.filter((name) => !deliveryNames.has(name))
  if (activation.kind === 'no_contract') return [...frozenAllowedToolNames]
  if (activation.kind === 'selection_required') {
    return withoutDelivery.filter((name) => name !== 'declare_completion_criteria')
  }
  if (activation.kind === 'pending') {
    return withoutDelivery
  }
  if (activation.kind === 'no_write') {
    return withoutDelivery.filter((name) => name !== 'declare_completion_criteria')
  }
  return frozenAllowedToolNames.filter((name) => name !== 'declare_completion_criteria')
}
