import { createHash, randomUUID } from 'crypto'

import { BrowserRepository } from '../repositories/browser-repository'
import type {
  BrowserCapabilityTaskHandle,
  BrowserCapabilityTaskKind,
  BrowserCapabilityTaskProgress,
  BrowserCapabilityTaskStatus,
  BrowserStartTaskRequest,
  BrowserTaskCheckpoint,
} from './capability-types'
import { taskEventBridge, toBridgeStatus } from './task-event-bridge'
import type { TaskExecutionBinding } from '../../../shared/agent-execution-profile'
import type { BrowserActionOutcome } from '../../../shared/browser-action-outcome'
import { buildBrowserTaskEventExtra } from './browser-task-event-presentation'
import {
  assessBrowserResearch,
  parseBrowserResearchState,
  parseBrowserWorkflowActionJournal,
  parseBrowserWorkflowObservationResources,
  readVerifiedBrowserWorkflowEvidence,
  verifyBrowserObservationResource,
  type BrowserResearchAssessment,
  type BrowserWorkflowActionJournal,
  type BrowserWorkflowObservationReceipt,
  type BrowserWorkflowObservationResource,
  type VerifiedBrowserWorkflowEvidence,
  type SettledBrowserWorkflowAction,
} from './browser-workflow-evidence'

export type {
  BeginBrowserWorkflowActionInput,
  BrowserResearchAssessment,
  BrowserResearchEvidenceBindingInput,
  BrowserResearchEvidenceRef,
  BrowserResearchWorkItem,
  BrowserResearchWorkItemInput,
  BrowserWorkflowActionJournal,
  BrowserWorkflowActiveAction,
  BrowserWorkflowObservationReceipt,
  BrowserWorkflowObservationResource,
  VerifiedBrowserWorkflowEvidence,
  RecordBrowserWorkflowObservationInput,
  SettledBrowserWorkflowAction,
} from './browser-workflow-evidence'

function parseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function monotonicIsoAfter(previous: string): string {
  const previousMs = Date.parse(previous)
  const now = Date.now()
  return new Date(Number.isFinite(previousMs) ? Math.max(now, previousMs + 1) : now).toISOString()
}

function isTerminalStatus(status: BrowserCapabilityTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function parsePersistedTaskPayload(record: import('../database/records').BrowserTaskRecord): Record<string, unknown> {
  try {
    const payload = asRecord(JSON.parse(record.payload_json))
    if (payload) return payload
  } catch {
    // Browser workflow state is authoritative and must never reset on parse failure.
  }
  if (record.kind === 'browser_workflow') throw new Error('browser_workflow_payload_corrupt')
  return {}
}

function targetIdentity(value: unknown, index: number): { id: string; url: string | null } | null {
  const record = asRecord(value)
  if (!record) return null
  const url = readString(record, ['url', 'canonicalUrl', 'openUrl', 'sourceUrl', 'link'])
  const id = readString(record, ['sourceId', 'id', 'targetId']) || url || `target-${index + 1}`
  return { id, url }
}

type BrowserTaskFailureClassification = NonNullable<BrowserTaskCheckpoint['failures']>[number]['classification']

const FAILURE_CLASSIFICATIONS = new Set<BrowserTaskFailureClassification>([
  'verification', 'rate_limit', 'network', 'target_missing', 'unavailable', 'authorization', 'unknown',
])

function failureClassification(value: unknown): BrowserTaskFailureClassification {
  const record = asRecord(value)
  const declared = String(record?.classification || '') as BrowserTaskFailureClassification
  if (FAILURE_CLASSIFICATIONS.has(declared)) return declared
  if (record?.challenge === true || record?.loginWall === true) return 'verification'
  const status = Number(record?.status || record?.statusCode || 0)
  if (status === 429) return 'rate_limit'
  const errorKind = String(record?.errorKind || record?.errorCode || '').toLowerCase()
  if (['challenge_required', 'verification_required', 'login_required', 'auth_required'].includes(errorKind)) return 'verification'
  if (['rate_limited', 'origin_rate_limited'].includes(errorKind)) return 'rate_limit'
  if (['network_error', 'browser_operation_timeout', 'navigation_failed'].includes(errorKind)) return 'network'
  if (['target_not_found', 'target_stale', 'target_ambiguous'].includes(errorKind)) return 'target_missing'
  if (['content_unavailable', 'unsupported_operation', 'resource_not_found'].includes(errorKind)) return 'unavailable'
  if (['authorization_denied', 'permission_denied', 'lease_denied'].includes(errorKind)) return 'authorization'
  return 'unknown'
}

function checkpointTargetSources(payload: Record<string, unknown>, partialResults: unknown): unknown[] {
  const plan = asRecord(payload.plan)
  const partial = asRecord(partialResults)
  if (Array.isArray(plan?.notes)) return plan.notes
  if (Array.isArray(payload.urls)) return payload.urls.map((url) => ({ url }))
  if (Array.isArray(partial?.targets)) return partial.targets
  if (Array.isArray(partialResults)) return partialResults
  return []
}

function checkpointOutputs(partialResults: unknown, result: unknown): unknown[] {
  const partial = asRecord(partialResults)
  const resultRecord = asRecord(result)
  if (Array.isArray(partial?.outputs)) return partial.outputs
  if (Array.isArray(resultRecord?.notes)) return resultRecord.notes
  if (Array.isArray(resultRecord?.results)) return resultRecord.results
  if (Array.isArray(partialResults)) return partialResults
  return []
}

function checkpointFailures(partialResults: unknown, result: unknown): unknown[] {
  const partial = asRecord(partialResults)
  const resultRecord = asRecord(result)
  if (Array.isArray(partial?.failed)) return partial.failed
  if (Array.isArray(resultRecord?.failed)) return resultRecord.failed
  return []
}

export function enrichBrowserTaskCheckpoint(
  checkpoint: Omit<BrowserTaskCheckpoint, 'targetList' | 'failures' | 'outputHashes' | 'binding' | 'nextStep'> & Partial<BrowserTaskCheckpoint>,
  payload: Record<string, unknown>,
  result?: unknown,
): BrowserTaskCheckpoint {
  const targets = checkpointTargetSources(payload, checkpoint.partialResults)
    .map(targetIdentity)
    .filter((target): target is { id: string; url: string | null } => target !== null)
  const outputs = checkpointOutputs(checkpoint.partialResults, result)
  const failures = checkpointFailures(checkpoint.partialResults, result)
  const terminal = ['completed', 'failed', 'cancelled'].includes(checkpoint.stage)
  const cursor = checkpoint.cursor === undefined ? null : checkpoint.cursor
  const tabId = readString(payload, ['tabId', 'agentTabId'])
  const epoch = Number(payload.documentEpoch)
  return {
    ...checkpoint,
    targetList: checkpoint.targetList || targets,
    failures: checkpoint.failures || failures.map((failure, index) => {
      const record = asRecord(failure)
      const identity = targetIdentity(failure, index)
      const classification = failureClassification(failure)
      return {
        targetId: identity?.id || `failure-${index + 1}`,
        classification,
        retryable: typeof record?.retryable === 'boolean'
          ? record.retryable
          : classification === 'network' || classification === 'rate_limit',
      }
    }),
    outputHashes: checkpoint.outputHashes || outputs.map((output, index) => ({
      targetId: targetIdentity(output, index)?.id || `output-${index + 1}`,
      sha256: sha256(output),
    })),
    binding: checkpoint.binding || {
      tabId,
      documentEpoch: Number.isFinite(epoch) && epoch > 0 ? Math.floor(epoch) : null,
    },
    nextStep: checkpoint.nextStep || {
      action: terminal ? 'none' : checkpoint.stage.includes('verification') ? 'verify' : 'resume',
      cursor,
    },
  }
}

function readString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function recordToHandle(record: import('../database/records').BrowserTaskRecord): BrowserCapabilityTaskHandle {
  return {
    taskId: record.id,
    kind: record.kind as BrowserCapabilityTaskKind,
    status: record.status as BrowserCapabilityTaskStatus,
    progress: {
      total: Number(record.progress_total || 0),
      completed: Number(record.progress_completed || 0),
      failed: Number(record.progress_failed || 0),
      currentLabel: record.current_label,
    },
    checkpoint: parseJSON<BrowserTaskCheckpoint | null>(record.checkpoint_json, null),
    result: parseJSON<unknown>(record.result_json, null),
    error: record.error,
    createdAt: record.created_at,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    updatedAt: record.updated_at,
    revision: Number(record.revision || 0),
    createdByRunId: record.created_by_run_id || null,
    activeExecutionBinding: parseJSON<TaskExecutionBinding | null>(record.active_execution_binding_json, null),
    parentTaskId: record.parent_task_id || null,
    projectionRevision: Number(record.projection_revision || 0),
    projectionSync: parseJSON<Record<string, unknown> | null>(record.projection_sync_json, null),
  }
}

function preserveBrowserWorkflowJournal(
  record: import('../database/records').BrowserTaskRecord,
  requested: Record<string, unknown>,
): Record<string, unknown> {
  if (record.kind !== 'browser_workflow') return requested
  const current = parsePersistedTaskPayload(record)
  return {
    ...requested,
    ...(Object.prototype.hasOwnProperty.call(current, 'browserWorkflowActionJournal')
      ? { browserWorkflowActionJournal: current.browserWorkflowActionJournal }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(current, 'browserWorkflowObservationResources')
      ? { browserWorkflowObservationResources: current.browserWorkflowObservationResources }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(current, 'browserResearch')
      ? { browserResearch: current.browserResearch }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(current, 'executionBinding')
      ? { executionBinding: current.executionBinding }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(current, 'parentTaskId')
      ? { parentTaskId: current.parentTaskId }
      : {}),
  }
}

export class BrowserTaskPersistenceService {
  constructor(private readonly repository = new BrowserRepository()) {}

  createTask(request: BrowserStartTaskRequest): BrowserCapabilityTaskHandle {
    const now = new Date().toISOString()
    const taskId = `browser-task-${randomUUID()}`
    const executionBinding = asRecord(request.payload.executionBinding)
    const createdByRunId = readString(request.payload, ['ownerRunId']) || readString(executionBinding, ['runId'])
    const parentTaskId = readString(request.payload, ['parentTaskId'])
    this.repository.createTask({
      id: taskId,
      kind: request.kind,
      status: 'queued',
      payload_json: JSON.stringify(request.payload || {}),
      checkpoint_json: null,
      result_json: null,
      progress_total: 0,
      progress_completed: 0,
      progress_failed: 0,
      current_label: null,
      error: null,
      created_at: now,
      started_at: null,
      updated_at: now,
      finished_at: null,
      created_by_run_id: createdByRunId,
      active_execution_binding_json: executionBinding ? JSON.stringify(executionBinding) : null,
      parent_task_id: parentTaskId,
    })
    return {
      taskId,
      kind: request.kind,
      status: 'queued',
      progress: { total: 0, completed: 0, failed: 0, currentLabel: null },
      createdAt: now,
      updatedAt: now,
      revision: 0,
      createdByRunId,
      activeExecutionBinding: executionBinding as unknown as TaskExecutionBinding | null,
      parentTaskId,
      projectionRevision: 0,
      projectionSync: null,
    }
  }

  getTask(taskId: string): BrowserCapabilityTaskHandle | null {
    const record = this.repository.getTask(taskId)
    if (!record) return null
    return recordToHandle(record)
  }

  getTaskPayload(taskId: string): Record<string, unknown> | null {
    const record = this.repository.getTask(taskId)
    if (!record) return null
    return parsePersistedTaskPayload(record)
  }

  readSettledOutcomes(taskId: string): BrowserActionOutcome[] {
    const payload = this.getTaskPayload(taskId)
    if (!payload) return []
    try {
      return parseBrowserWorkflowActionJournal(payload, taskId)
        .settledOutcomes
        .slice()
        .sort((left, right) => left.actionSeq - right.actionSeq)
        .map((item) => item.outcome)
    } catch {
      return []
    }
  }

  assessResearch(taskId: string): BrowserResearchAssessment {
    const record = this.repository.getTask(taskId)
    if (!record) throw new Error(`browser_workflow_task_not_found:${taskId}`)
    if (record.kind !== 'browser_workflow') throw new Error(`browser_workflow_task_kind_required:${record.kind}`)
    return assessBrowserResearch(taskId, parseBrowserResearchState(parsePersistedTaskPayload(record)))
  }

  readHighestSettledAction(taskId: string): SettledBrowserWorkflowAction | null {
    const payload = this.getTaskPayload(taskId)
    if (!payload) return null
    const journal = parseBrowserWorkflowActionJournal(payload, taskId)
    const highest = journal.settledOutcomes.reduce<BrowserWorkflowActionJournal['settledOutcomes'][number] | null>(
      (current, item) => !current || item.actionSeq > current.actionSeq ? item : current,
      null,
    )
    return highest
      ? { receiptId: highest.receiptId, actionId: highest.actionId, actionSeq: highest.actionSeq, outcome: highest.outcome }
      : null
  }

  readHighestObservation(taskId: string): BrowserWorkflowObservationReceipt | null {
    const payload = this.getTaskPayload(taskId)
    if (!payload) return null
    const journal = parseBrowserWorkflowActionJournal(payload, taskId)
    return journal.observationReceipts.reduce<BrowserWorkflowObservationReceipt | null>(
      (current, item) => !current || item.observationSeq > current.observationSeq ? item : current,
      null,
    )
  }

  readObservationResource(taskId: string, resourceId: string): BrowserWorkflowObservationResource | null {
    const payload = this.getTaskPayload(taskId)
    if (!payload) return null
    const resource = parseBrowserWorkflowObservationResources(payload, taskId).find((item) => item.resourceId === resourceId)
    const receipt = parseBrowserWorkflowActionJournal(payload, taskId).observationReceipts
      .find((item) => item.resourceId === resourceId)
    if (!resource || !receipt) return null
    return verifyBrowserObservationResource(taskId, resource, receipt)
  }

  listObservationResources(taskId: string): BrowserWorkflowObservationResource[] {
    const payload = this.getTaskPayload(taskId)
    if (!payload) return []
    const receiptList = parseBrowserWorkflowActionJournal(payload, taskId).observationReceipts
    const receipts = new Map(receiptList
      .map((receipt) => [receipt.resourceId, receipt]))
    const resources = parseBrowserWorkflowObservationResources(payload, taskId)
    if (receipts.size !== receiptList.length || resources.length !== receiptList.length) {
      throw new Error('browser_observation_resource_receipt_set_mismatch')
    }
    return resources.map((resource) => {
      const receipt = receipts.get(resource.resourceId)
      if (!receipt) throw new Error('browser_observation_resource_receipt_set_mismatch')
      return verifyBrowserObservationResource(taskId, resource, receipt)
    })
  }

  readVerifiedWorkflowEvidence(taskId: string): VerifiedBrowserWorkflowEvidence {
    const record = this.repository.getTask(taskId)
    if (!record) throw new Error(`browser_workflow_task_not_found:${taskId}`)
    if (record.kind !== 'browser_workflow') throw new Error(`browser_workflow_task_kind_required:${record.kind}`)
    return readVerifiedBrowserWorkflowEvidence(
      taskId,
      parsePersistedTaskPayload(record),
    )
  }

  updateTaskPayload(taskId: string, payload: Record<string, unknown>): boolean {
    const record = this.repository.getTask(taskId)
    if (!record) return false
    const nextPayload = preserveBrowserWorkflowJournal(record, payload || {})
    const expectedUpdatedAt = String(record.updated_at || record.created_at || '')
    return this.repository.updateTask(taskId, {
      payload_json: JSON.stringify(nextPayload),
      active_execution_binding_json: record.kind === 'browser_workflow'
        ? undefined
        : nextPayload.executionBinding && typeof nextPayload.executionBinding === 'object'
          ? JSON.stringify(nextPayload.executionBinding)
          : null,
      parent_task_id: record.kind === 'browser_workflow' ? undefined : readString(nextPayload, ['parentTaskId']),
      updated_at: monotonicIsoAfter(expectedUpdatedAt),
    }, expectedUpdatedAt ? { expectedUpdatedAt } : undefined)
  }

  compareAndSetTaskState(
    taskId: string,
    expectedUpdatedAt: string,
    update: {
      payload?: Record<string, unknown>
      progress?: Partial<BrowserCapabilityTaskProgress>
      checkpoint?: BrowserTaskCheckpoint | null
      status?: BrowserCapabilityTaskStatus
      error?: string | null
      result?: unknown
      startedAt?: string | null
      finishedAt?: string | null
    },
  ): { committed: boolean; task: BrowserCapabilityTaskHandle | null } {
    const record = this.repository.getTask(taskId)
    if (!record) return { committed: false, task: null }
    const current = recordToHandle(record)
    if (record.updated_at !== expectedUpdatedAt) return { committed: false, task: current }
    const requestedStatus = update.status ?? current.status
    if (isTerminalStatus(current.status) && requestedStatus !== current.status) {
      return { committed: false, task: current }
    }
    const payload = update.payload
      ? preserveBrowserWorkflowJournal(record, update.payload)
      : parsePersistedTaskPayload(record)
    const progress = update.progress || {}
    const nextProgress: BrowserCapabilityTaskProgress = {
      total: progress.total ?? current.progress.total,
      completed: progress.completed ?? current.progress.completed,
      failed: progress.failed ?? current.progress.failed,
      currentLabel: Object.prototype.hasOwnProperty.call(progress, 'currentLabel')
        ? progress.currentLabel ?? null
        : current.progress.currentLabel ?? null,
    }
    const committed = this.repository.updateTask(taskId, {
      status: requestedStatus,
      payload_json: update.payload ? JSON.stringify(payload) : undefined,
      active_execution_binding_json: update.payload && record.kind !== 'browser_workflow'
        ? payload.executionBinding && typeof payload.executionBinding === 'object'
          ? JSON.stringify(payload.executionBinding)
          : null
        : undefined,
      parent_task_id: update.payload && record.kind !== 'browser_workflow'
        ? readString(payload, ['parentTaskId'])
        : undefined,
      checkpoint_json: update.checkpoint !== undefined
        ? JSON.stringify(update.checkpoint === null
          ? null
          : enrichBrowserTaskCheckpoint(
              update.checkpoint,
              payload,
              update.result !== undefined ? update.result : current.result,
            ))
        : undefined,
      result_json: update.result !== undefined ? JSON.stringify(update.result) : undefined,
      progress_total: nextProgress.total,
      progress_completed: nextProgress.completed,
      progress_failed: nextProgress.failed,
      current_label: nextProgress.currentLabel ?? null,
      error: Object.prototype.hasOwnProperty.call(update, 'error') ? update.error ?? null : undefined,
      started_at: update.startedAt,
      finished_at: update.finishedAt,
      updated_at: monotonicIsoAfter(expectedUpdatedAt),
    }, { expectedUpdatedAt })
    const task = this.getTask(taskId)
    if (!committed) return { committed: false, task }
    const bridgeStatus = update.status ? toBridgeStatus(update.status) : null
    if (bridgeStatus) {
      taskEventBridge.publish({
        taskId,
        status: bridgeStatus,
        extra: buildBrowserTaskEventExtra(task, this.getTaskPayload(taskId)),
      })
    }
    return { committed: true, task }
  }

  patchTaskPayload(taskId: string, patch: Record<string, unknown>): boolean {
    const record = this.repository.getTask(taskId)
    if (!record) return false
    const payload = preserveBrowserWorkflowJournal(record, {
      ...parsePersistedTaskPayload(record),
      ...patch,
    })
    const expectedUpdatedAt = String(record.updated_at || record.created_at || '')
    return this.repository.updateTask(taskId, {
      payload_json: JSON.stringify(payload),
      active_execution_binding_json: record.kind === 'browser_workflow'
        ? undefined
        : payload.executionBinding && typeof payload.executionBinding === 'object'
          ? JSON.stringify(payload.executionBinding)
          : null,
      parent_task_id: record.kind === 'browser_workflow' ? undefined : readString(payload, ['parentTaskId']),
      updated_at: monotonicIsoAfter(expectedUpdatedAt),
    }, expectedUpdatedAt ? { expectedUpdatedAt } : undefined)
  }

  updateProjectionSync(taskId: string, input: {
    projectionRevision: number
    sync: Record<string, unknown> | null
  }): BrowserCapabilityTaskHandle | null {
    const current = this.getTask(taskId)
    if (!current) return null
    const expectedUpdatedAt = String(current.updatedAt || current.createdAt || '')
    const committed = this.repository.updateTask(taskId, {
      projection_revision: Math.max(
        Number(current.projectionRevision || 0),
        Math.max(0, Math.floor(input.projectionRevision)),
      ),
      projection_sync_json: input.sync ? JSON.stringify(input.sync) : null,
      updated_at: monotonicIsoAfter(expectedUpdatedAt),
    }, { ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}), incrementRevision: false })
    if (committed === false) return this.getTask(taskId)
    return this.getTask(taskId)
  }

  updateProgress(taskId: string, progress: Partial<BrowserCapabilityTaskProgress>, extras?: {
    checkpoint?: BrowserTaskCheckpoint | null
    status?: BrowserCapabilityTaskStatus
    error?: string | null
    result?: unknown
    startedAt?: string | null
    finishedAt?: string | null
  }): BrowserCapabilityTaskHandle | null {
    const current = this.getTask(taskId)
    if (!current) return null
    const requestedStatus = extras?.status ?? current.status
    if (isTerminalStatus(current.status) && requestedStatus !== current.status) {
      return current
    }

    const nextProgress: BrowserCapabilityTaskProgress = {
      total: progress.total ?? current.progress.total,
      completed: progress.completed ?? current.progress.completed,
      failed: progress.failed ?? current.progress.failed,
      currentLabel: Object.prototype.hasOwnProperty.call(progress, 'currentLabel')
        ? progress.currentLabel ?? null
        : current.progress.currentLabel ?? null,
    }
    const expectedUpdatedAt = String(current.updatedAt || current.createdAt || '')
    const updatedAt = monotonicIsoAfter(expectedUpdatedAt)
    const committed = this.repository.updateTask(taskId, {
      status: requestedStatus,
      checkpoint_json: extras?.checkpoint !== undefined
        ? JSON.stringify(extras.checkpoint === null
          ? null
          : enrichBrowserTaskCheckpoint(
              extras.checkpoint,
              this.getTaskPayload(taskId) || {},
              extras.result !== undefined ? extras.result : current.result,
            ))
        : undefined,
      result_json: extras?.result !== undefined ? JSON.stringify(extras.result) : undefined,
      progress_total: nextProgress.total,
      progress_completed: nextProgress.completed,
      progress_failed: nextProgress.failed,
      current_label: nextProgress.currentLabel ?? null,
      error: extras && Object.prototype.hasOwnProperty.call(extras, 'error')
        ? extras.error ?? null
        : current.error ?? null,
      started_at: extras?.startedAt,
      finished_at: extras?.finishedAt,
      updated_at: updatedAt,
    }, expectedUpdatedAt ? { expectedUpdatedAt } : undefined)

    if (committed === false) return this.getTask(taskId)

    const updated = this.getTask(taskId)
    const bridgeStatus = extras?.status ? toBridgeStatus(extras.status) : null
    if (bridgeStatus) {
      taskEventBridge.publish({
        taskId,
        status: bridgeStatus,
        extra: buildBrowserTaskEventExtra(updated, this.getTaskPayload(taskId)),
      })
    }
    return updated
  }

  listPendingTasks(): BrowserCapabilityTaskHandle[] {
    return this.repository
      .listTasks(['queued', 'running', 'paused'])
      .map(recordToHandle)
  }

  listTasks(): BrowserCapabilityTaskHandle[] {
    return this.repository
      .listTasks()
      .map(recordToHandle)
  }
}
