import type { AgentInputItem } from '@openai/agents'
import type {
  AgentCheckpointRefs,
  DurableRequestAnchor,
  HumanTakeoverRef,
  ParentSteeringReceipt,
} from '../../../shared/browser-workflow-control'
import type { PreparedSkillTurnTruth } from '../agent-control/contracts/browser-workflow-control'
import { assertAgentInputToolPairIntegrity } from '../agent-control/compaction/compact-agent-input'
import {
  digestSerializedJson,
  parseArrayStrict,
  parseJsonStrict,
  parseObjectStrict,
} from './browser-workflow-codec'
import type { WorkflowRawDatabase } from './browser-workflow-unit-of-work'

export interface BrowserWorkflowParentRecord {
  taskId: string
  scopeId: string
  runId: string
  revision: number
  dependencyGeneration: number
  status: string
  requestAnchor: DurableRequestAnchor | null
  steeringReceipts: ParentSteeringReceipt[]
  humanTakeoverRef: HumanTakeoverRef | null
  checkpointRefs: AgentCheckpointRefs
}

export interface AgentSessionCheckpoint {
  checkpointId: string
  role: 'clean_base' | 'suspension'
  parentTaskId: string
  browserTaskId: string | null
  ownerRunId: string
  ancestorOwnerRunId: string | null
  ancestorCheckpointDigest: string | null
  schemaMajor: number
  serializerMajor: number
  registryMajor: number
  safetyMajor: number
  finalInput: AgentInputItem[]
  finalInputDigest: string
  sdkSourceItemCount: number
  sdkSourcePrefixDigest: string
  lastEffectiveBrowserActionSeq: number
  steeringReceiptIds: string[]
  steeringReceiptDigests: string[]
  requiredOperationIds: string[]
  resourceRefs: string[]
  preparedSkill: PreparedSkillTurnTruth
  activatedCapabilityGroups: string[]
  createdAt: string
}

export interface WorkflowParentRow {
  task_id: string
  scope_id: string
  run_id: string
  revision: number | null
  dependency_generation: number | null
  status: string
  request_anchor_json: string | null
  steering_receipts_json: string | null
  human_takeover_ref_json: string | null
  checkpoint_refs_json: string | null
}

export interface WorkflowCheckpointRow {
  checkpoint_id: string
  role: 'clean_base' | 'suspension'
  parent_task_id: string
  browser_task_id: string | null
  owner_run_id: string
  ancestor_owner_run_id: string | null
  ancestor_checkpoint_digest: string | null
  schema_major: number
  serializer_major: number
  registry_major: number
  safety_major: number
  final_input_json: string
  final_input_digest: string
  sdk_source_item_count: number
  sdk_source_prefix_digest: string
  last_effective_browser_action_seq: number
  steering_receipt_ids_json: string
  steering_receipt_digests_json: string
  required_operation_ids_json: string
  resource_refs_json: string
  prepared_skill_json: string
  activated_capability_groups_json: string
  created_at: string
}

function nullableObject<T extends object>(raw: string | null | undefined, field: string): T | null {
  if (raw === null || raw === undefined || raw === '') return null
  const parsed = parseJsonStrict(raw, field)
  if (parsed === null) return null
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${field}_wrong_shape`)
  return parsed as T
}

function checkpointRefs(raw: string | null): AgentCheckpointRefs {
  const value = parseObjectStrict<AgentCheckpointRefs>(raw, 'checkpoint_refs_json')
  if (
    !Object.hasOwn(value, 'cleanBaseCheckpointId')
    || !Object.hasOwn(value, 'suspensionCheckpointId')
    || (value.cleanBaseCheckpointId !== null && typeof value.cleanBaseCheckpointId !== 'string')
    || (value.suspensionCheckpointId !== null && typeof value.suspensionCheckpointId !== 'string')
  ) throw new Error('checkpoint_refs_json_wrong_shape')
  return value
}

export function mapWorkflowParentRow(row: WorkflowParentRow): BrowserWorkflowParentRecord {
  return {
    taskId: row.task_id,
    scopeId: row.scope_id,
    runId: row.run_id,
    revision: Number(row.revision || 0),
    dependencyGeneration: Number(row.dependency_generation || 0),
    status: row.status,
    requestAnchor: nullableObject<DurableRequestAnchor>(row.request_anchor_json, 'request_anchor_json'),
    steeringReceipts: parseArrayStrict<ParentSteeringReceipt>(row.steering_receipts_json ?? '[]', 'steering_receipts_json'),
    humanTakeoverRef: nullableObject<HumanTakeoverRef>(row.human_takeover_ref_json, 'human_takeover_ref_json'),
    checkpointRefs: checkpointRefs(row.checkpoint_refs_json),
  }
}

export function readWorkflowParent(db: WorkflowRawDatabase, taskId: string): BrowserWorkflowParentRecord {
  const row = db.prepare(
    `SELECT task_id, scope_id, run_id, revision, dependency_generation, status,
            request_anchor_json, steering_receipts_json, human_takeover_ref_json, checkpoint_refs_json
       FROM task_projections WHERE task_id = ? LIMIT 1`,
  ).get<WorkflowParentRow>(taskId)
  if (!row) throw new Error('browser_workflow_parent_not_found')
  return mapWorkflowParentRow(row)
}

export function mapWorkflowCheckpointRow(row: WorkflowCheckpointRow): AgentSessionCheckpoint {
  const finalInput = parseArrayStrict<AgentInputItem>(row.final_input_json, 'checkpoint_final_input_json')
  assertAgentInputToolPairIntegrity(finalInput)
  if (digestSerializedJson(row.final_input_json) !== row.final_input_digest) {
    throw new Error('checkpoint_digest_mismatch')
  }
  return {
    checkpointId: row.checkpoint_id,
    role: row.role,
    parentTaskId: row.parent_task_id,
    browserTaskId: row.browser_task_id,
    ownerRunId: row.owner_run_id,
    ancestorOwnerRunId: row.ancestor_owner_run_id,
    ancestorCheckpointDigest: row.ancestor_checkpoint_digest,
    schemaMajor: row.schema_major,
    serializerMajor: row.serializer_major,
    registryMajor: row.registry_major,
    safetyMajor: row.safety_major,
    finalInput,
    finalInputDigest: row.final_input_digest,
    sdkSourceItemCount: row.sdk_source_item_count,
    sdkSourcePrefixDigest: row.sdk_source_prefix_digest,
    lastEffectiveBrowserActionSeq: row.last_effective_browser_action_seq,
    steeringReceiptIds: parseArrayStrict<string>(row.steering_receipt_ids_json, 'steering_receipt_ids_json'),
    steeringReceiptDigests: parseArrayStrict<string>(row.steering_receipt_digests_json, 'steering_receipt_digests_json'),
    requiredOperationIds: parseArrayStrict<string>(row.required_operation_ids_json, 'required_operation_ids_json'),
    resourceRefs: parseArrayStrict<string>(row.resource_refs_json, 'resource_refs_json'),
    preparedSkill: parseObjectStrict<PreparedSkillTurnTruth>(row.prepared_skill_json, 'prepared_skill_json'),
    activatedCapabilityGroups: parseArrayStrict<string>(row.activated_capability_groups_json, 'activated_capability_groups_json'),
    createdAt: row.created_at,
  }
}
