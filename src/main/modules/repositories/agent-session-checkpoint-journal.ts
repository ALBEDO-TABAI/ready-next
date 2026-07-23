import { createHash } from 'node:crypto'

import type { TaskExecutionBinding } from '../../../shared/agent-execution-profile'
import type { BrowserActionOutcome } from '../../../shared/browser-action-outcome'
import { browserOperationCapability } from '../../../shared/browser-capability-registry'
import {
  assessBrowserResearch,
  browserObservationProvenanceDigest,
  browserResearchBoundedString,
  browserWorkflowStableDigest,
  hasCompleteBrowserDocumentIdentity,
  parseBrowserResearchState,
  parseBrowserWorkflowActionJournal,
  parseBrowserWorkflowObservationResources,
  sameBrowserDocumentIdentity,
  stableBrowserResearchWorkItem,
  verifyBrowserObservationResource,
  type BeginBrowserWorkflowActionInput,
  type BrowserResearchAssessment,
  type BrowserResearchEvidenceBindingInput,
  type BrowserResearchEvidenceRef,
  type BrowserResearchPayloadState,
  type BrowserResearchWorkItemInput,
  type BrowserWorkflowActionJournal,
  type BrowserWorkflowActiveAction,
  type BrowserWorkflowObservationReceipt,
  type BrowserWorkflowObservationResource,
  type RecordBrowserWorkflowObservationInput,
  type SettledBrowserWorkflowAction,
} from '../browser-engine/browser-workflow-evidence'
import {
  parseObjectStrict,
  serializeWorkflowJson,
  workflowDigest,
} from './browser-workflow-codec'
import { readWorkflowParent } from './browser-workflow-row-mapping'
import type {
  BrowserWorkflowUnitOfWork,
  WorkflowRawDatabase,
} from './browser-workflow-unit-of-work'

interface BrowserWorkflowJournalRow {
  id: string
  parent_task_id: string | null
  kind: string
  status: string
  payload_json: string | null
  active_execution_binding_json: string | null
  updated_at: string
  revision: number | null
}

function changed(result: unknown): number {
  return Number((result as { changes?: unknown } | null)?.changes || 0)
}

function monotonicIsoAfter(previous: string): string {
  const previousMs = Date.parse(previous)
  const now = Date.now()
  return new Date(Number.isFinite(previousMs) ? Math.max(now, previousMs + 1) : now).toISOString()
}

function readJournalRow(db: WorkflowRawDatabase, browserTaskId: string): BrowserWorkflowJournalRow {
  const row = db.prepare(
    `SELECT id, parent_task_id, kind, status, payload_json,
            active_execution_binding_json, updated_at, revision
       FROM browser_tasks WHERE id = ? LIMIT 1`,
  ).get<BrowserWorkflowJournalRow>(browserTaskId)
  if (!row) throw new Error(`browser_workflow_task_not_found:${browserTaskId}`)
  if (row.kind !== 'browser_workflow') throw new Error(`browser_workflow_task_kind_required:${row.kind}`)
  if (!row.parent_task_id) throw new Error('browser_workflow_parent_task_missing')
  return row
}

function readPayloadAndJournal(row: BrowserWorkflowJournalRow): {
  payload: Record<string, unknown>
  journal: BrowserWorkflowActionJournal
} {
  if (!row.payload_json) throw new Error('browser_workflow_payload_corrupt')
  const payload = parseObjectStrict<Record<string, unknown>>(
    row.payload_json,
    'browser_workflow_payload_json',
  )
  if (!Object.prototype.hasOwnProperty.call(payload, 'browserWorkflowActionJournal')) {
    throw new Error('browser_workflow_action_journal_missing')
  }
  return {
    payload,
    journal: parseBrowserWorkflowActionJournal(payload, row.id),
  }
}

function readBinding(raw: string | null, field: string): TaskExecutionBinding {
  if (!raw) throw new Error(`${field}_missing`)
  return parseObjectStrict<TaskExecutionBinding>(raw, field)
}

function assertCurrentOwnerAuthority(
  db: WorkflowRawDatabase,
  row: BrowserWorkflowJournalRow,
  ownerRunId: string,
): void {
  const parent = readWorkflowParent(db, row.parent_task_id as string)
  if (
    parent.runId !== ownerRunId
    || parent.status !== 'running'
    || parent.humanTakeoverRef?.state === 'pending'
    || row.status !== 'running'
  ) throw new Error('browser_workflow_journal_authority_denied')

  const parentBinding = readBinding(
    db.prepare(
      'SELECT execution_binding_json FROM task_projections WHERE task_id = ? AND run_id = ? LIMIT 1',
    ).get<{ execution_binding_json: string | null }>(parent.taskId, ownerRunId)?.execution_binding_json ?? null,
    'browser_workflow_parent_execution_binding_json',
  )
  const childBinding = readBinding(
    row.active_execution_binding_json,
    'browser_workflow_child_execution_binding_json',
  )
  const run = db.prepare(
    `SELECT status, execution_binding_json FROM run_meta
      WHERE run_id = ? AND task_id = ? AND scope_id = ? LIMIT 1`,
  ).get<{ status: string; execution_binding_json: string | null }>(
    ownerRunId,
    parent.taskId,
    parent.scopeId,
  )
  if (run?.status !== 'running') throw new Error('browser_workflow_journal_authority_denied')
  const runBinding = readBinding(
    run.execution_binding_json,
    'browser_workflow_run_execution_binding_json',
  )
  const bindingDigest = workflowDigest(parentBinding)
  if (
    parentBinding.runId !== ownerRunId
    || childBinding.runId !== ownerRunId
    || runBinding.runId !== ownerRunId
    || workflowDigest(childBinding) !== bindingDigest
    || workflowDigest(runBinding) !== bindingDigest
  ) throw new Error('browser_workflow_journal_authority_denied')
}

function assertSettlementAuthority(
  db: WorkflowRawDatabase,
  row: BrowserWorkflowJournalRow,
  ownerRunId: string,
  active: BrowserWorkflowActiveAction,
): void {
  const parent = readWorkflowParent(db, row.parent_task_id as string)
  const run = db.prepare(
    `SELECT task_id, scope_id, execution_binding_json FROM run_meta
      WHERE run_id = ? LIMIT 1`,
  ).get<{
    task_id: string | null
    scope_id: string | null
    execution_binding_json: string | null
  }>(ownerRunId)
  if (
    active.ownerRunId !== ownerRunId
    || run?.task_id !== parent.taskId
    || run.scope_id !== parent.scopeId
  ) throw new Error('browser_workflow_settlement_authority_denied')
  const runBinding = readBinding(
    run.execution_binding_json,
    'browser_workflow_settlement_run_execution_binding_json',
  )
  if (runBinding.runId !== ownerRunId) {
    throw new Error('browser_workflow_settlement_authority_denied')
  }
}

function writeJournalPayload(
  db: WorkflowRawDatabase,
  row: BrowserWorkflowJournalRow,
  payload: Record<string, unknown>,
  progress?: { total: number; completed: number },
): void {
  const serialized = serializeWorkflowJson(payload, 'browser_workflow_payload_json')
  const updatedAt = monotonicIsoAfter(row.updated_at)
  const revision = Math.max(0, Math.floor(Number(row.revision || 0)))
  const updated = progress
    ? db.prepare(
      `UPDATE browser_tasks
          SET payload_json = ?, progress_total = ?, progress_completed = ?,
              progress_failed = 0, current_label = NULL,
              revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND payload_json = ?`,
    ).run(serialized, progress.total, progress.completed, updatedAt, row.id, revision, row.payload_json)
    : db.prepare(
      `UPDATE browser_tasks
          SET payload_json = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND payload_json = ?`,
    ).run(serialized, updatedAt, row.id, revision, row.payload_json)
  if (changed(updated) !== 1) throw new Error('browser_workflow_journal_revision_conflict')
}

function exactIdentity(left: unknown, right: unknown): boolean {
  return browserWorkflowStableDigest(left) === browserWorkflowStableDigest(right)
}

/** 工作项的内容身份：与 workItemId / evidenceRefIds / createdAt 无关。 */
function researchWorkItemContentDigest(item: {
  goalRefs: string[]
  requirement: string | null
  query: string | null
  url: string | null
  fieldGoals: string[]
  required: boolean
}): string {
  return browserWorkflowStableDigest({
    goalRefs: item.goalRefs,
    requirement: item.requirement,
    query: item.query,
    url: item.url,
    fieldGoals: item.fieldGoals,
    required: item.required,
  })
}

export class AgentSessionCheckpointJournalRepository {
  constructor(readonly unitOfWork: BrowserWorkflowUnitOfWork) {}

  beginBrowserWorkflowAction(input: BeginBrowserWorkflowActionInput): BrowserWorkflowActiveAction {
    const capability = browserOperationCapability(input.operationId)
    const validPredecessor = hasCompleteBrowserDocumentIdentity(input.identity)
      || (!capability.requiresDocument && input.identity.documentState === 'no_document')
    if (!validPredecessor) {
      throw new Error(`browser_action_predecessor_identity_incomplete:${input.operationId}`)
    }
    if (!String(input.argsDigest || '').trim()) throw new Error('browser_action_args_digest_required')
    if (input.searchActionId !== undefined && !input.searchActionId.trim()) {
      throw new Error('browser_search_action_id_required')
    }

    return this.unitOfWork.runImmediate((db) => {
      const row = readJournalRow(db, input.taskId)
      assertCurrentOwnerAuthority(db, row, input.ownerRunId)
      const { payload, journal } = readPayloadAndJournal(row)
      if (journal.activeAction) {
        throw new Error(`browser_action_already_in_flight:${journal.activeAction.actionId}`)
      }
      const actionSeq = journal.nextActionSeq
      const actionId = `browser-action-${browserWorkflowStableDigest({
        taskId: input.taskId,
        actionSeq,
        operationId: input.operationId,
        argsDigest: input.argsDigest,
      }).slice(0, 32)}`
      const activeAction: BrowserWorkflowActiveAction = {
        actionId,
        actionSeq,
        operationId: input.operationId,
        ownerRunId: input.ownerRunId,
        argsDigest: input.argsDigest,
        identity: input.identity,
        ...(input.operationId === 'search' || input.searchActionId
          ? {
              searchActionId: input.searchActionId || `browser-search-${browserWorkflowStableDigest({
                taskId: input.taskId,
                actionSeq,
                argsDigest: input.argsDigest,
              }).slice(0, 32)}`,
            }
          : {}),
        startedAt: new Date().toISOString(),
      }
      const nextJournal: BrowserWorkflowActionJournal = {
        nextActionSeq: actionSeq + 1,
        nextObservationSeq: journal.nextObservationSeq,
        activeAction,
        settledOutcomes: journal.settledOutcomes,
        observationReceipts: journal.observationReceipts,
      }
      parseBrowserWorkflowActionJournal(
        { browserWorkflowActionJournal: nextJournal },
        input.taskId,
      )
      writeJournalPayload(db, row, {
        ...payload,
        browserWorkflowActionJournal: nextJournal,
      })
      return activeAction
    })
  }

  settleBrowserWorkflowAction(
    taskId: string,
    actionId: string,
    outcome: BrowserActionOutcome,
  ): SettledBrowserWorkflowAction {
    return this.unitOfWork.runImmediate((db) => {
      const row = readJournalRow(db, taskId)
      const { payload, journal } = readPayloadAndJournal(row)
      const active = journal.activeAction
      if (!active || active.actionId !== actionId) {
        throw new Error(`browser_action_not_in_flight:${actionId}`)
      }
      assertSettlementAuthority(db, row, active.ownerRunId, active)
      const capability = browserOperationCapability(active.operationId)
      if (
        outcome.actionId !== actionId
        || outcome.actionSeq !== active.actionSeq
        || outcome.taskId !== taskId
        || outcome.ownerRunId !== active.ownerRunId
        || outcome.operationId !== active.operationId
        || outcome.mode !== capability.mode
        || !exactIdentity(outcome.identity, active.identity)
        || (active.searchActionId && outcome.search?.searchActionId !== active.searchActionId)
      ) throw new Error(`browser_action_outcome_binding_mismatch:${actionId}`)
      if (
        outcome.dispatch !== 'rejected'
        && capability.requiresDocument
        && !hasCompleteBrowserDocumentIdentity(outcome.successorIdentity)
      ) throw new Error(`browser_action_successor_identity_incomplete:${active.operationId}`)
      if (journal.settledOutcomes.length >= 4_096) {
        throw new Error('browser_action_journal_limit_reached')
      }
      const normalizedOutcome: BrowserActionOutcome = {
        ...outcome,
        actionId,
        actionSeq: active.actionSeq,
        taskId,
        ownerRunId: active.ownerRunId,
        operationId: active.operationId,
        mode: capability.mode,
        identity: active.identity,
        successorIdentity: outcome.successorIdentity,
      }
      const receiptId = `browser-receipt-${browserWorkflowStableDigest({
        taskId,
        actionId,
        normalizedOutcome,
      }).slice(0, 32)}`
      const nextJournal: BrowserWorkflowActionJournal = {
        nextActionSeq: journal.nextActionSeq,
        nextObservationSeq: journal.nextObservationSeq,
        activeAction: null,
        settledOutcomes: [...journal.settledOutcomes, {
          receiptId,
          actionId,
          actionSeq: active.actionSeq,
          outcome: normalizedOutcome,
          settledAt: new Date().toISOString(),
        }],
        observationReceipts: journal.observationReceipts,
      }
      parseBrowserWorkflowActionJournal(
        { browserWorkflowActionJournal: nextJournal },
        taskId,
      )
      writeJournalPayload(db, row, {
        ...payload,
        browserWorkflowActionJournal: nextJournal,
      })
      return { receiptId, actionId, actionSeq: active.actionSeq, outcome: normalizedOutcome }
    })
  }

  recordBrowserWorkflowObservation(
    input: RecordBrowserWorkflowObservationInput,
  ): BrowserWorkflowObservationReceipt {
    if (!hasCompleteBrowserDocumentIdentity(input.identity)) {
      throw new Error('browser_observation_identity_incomplete')
    }
    if (!String(input.resultDigest || '').trim()) throw new Error('browser_observation_digest_required')
    if (!String(input.resourceContent || '').trim()) {
      throw new Error('browser_observation_resource_content_required')
    }
    if (Buffer.byteLength(input.resourceContent, 'utf8') > 65_536) {
      throw new Error('browser_observation_resource_too_large')
    }
    let resourceValue: unknown
    try {
      resourceValue = JSON.parse(input.resourceContent)
    } catch {
      throw new Error('browser_observation_resource_invalid_json')
    }
    const resourceRecord = resourceValue && typeof resourceValue === 'object' && !Array.isArray(resourceValue)
      ? resourceValue as Record<string, unknown>
      : null
    if (!resourceRecord || resourceRecord.operationId !== input.operationId) {
      throw new Error('browser_observation_resource_operation_mismatch')
    }
    if (browserWorkflowStableDigest(resourceValue) !== input.resultDigest) {
      throw new Error('browser_observation_result_digest_mismatch')
    }

    return this.unitOfWork.runImmediate((db) => {
      const row = readJournalRow(db, input.taskId)
      assertCurrentOwnerAuthority(db, row, input.ownerRunId)
      const { payload, journal } = readPayloadAndJournal(row)
      const resources = parseBrowserWorkflowObservationResources(payload, input.taskId)
      if (resources.length >= 4_096) throw new Error('browser_observation_resource_limit_reached')
      if (journal.activeAction) {
        throw new Error(`browser_observation_while_action_in_flight:${journal.activeAction.actionId}`)
      }
      const observationSeq = journal.nextObservationSeq
      const alreadyObserved = new Set(journal.observationReceipts.flatMap((receipt) =>
        receipt.causalActions.map((action) => `${action.actionId}:${action.actionSeq}`)))
      const candidates = journal.settledOutcomes
        .filter((item) => !alreadyObserved.has(`${item.actionId}:${item.actionSeq}`))
        .filter((item) => item.outcome.dispatch !== 'rejected'
          && item.outcome.delivery !== 'not_delivered'
          && (item.outcome.needsObservation || item.outcome.mayHaveCommitted || item.outcome.effect === 'observed'))
        .sort((left, right) => right.actionSeq - left.actionSeq)
      const causalActions: BrowserWorkflowObservationReceipt['causalActions'] = []
      let cursorIdentity = input.identity
      for (const item of candidates) {
        const successor = item.outcome.successorIdentity
        if (!hasCompleteBrowserDocumentIdentity(successor)) continue
        if (!sameBrowserDocumentIdentity(successor, cursorIdentity)) continue
        causalActions.unshift({
          actionId: item.actionId,
          actionSeq: item.actionSeq,
          predecessorIdentity: item.outcome.identity,
          successorIdentity: successor,
          searchActionId: item.outcome.search?.searchActionId || null,
          queryDigest: item.outcome.search?.queryDigest || null,
        })
        cursorIdentity = item.outcome.identity
      }
      const observedAfterActionSeq = causalActions.reduce(
        (highest, action) => Math.max(highest, action.actionSeq),
        0,
      )
      const receiptIdentity = causalActions.at(-1)?.successorIdentity || input.identity
      const linkedSearch = [...causalActions].reverse()
        .find((action) => action.searchActionId && action.queryDigest) || null
      const observedAt = new Date().toISOString()
      const contentDigest = createHash('sha256').update(input.resourceContent).digest('hex')
      const provenanceDigest = browserObservationProvenanceDigest(input.taskId, {
        operationId: input.operationId,
        ownerRunId: input.ownerRunId,
        identity: receiptIdentity,
        resultDigest: input.resultDigest,
        observedAt,
      })
      const resourceId = `browser-observation-resource-${browserWorkflowStableDigest({
        taskId: input.taskId,
        observationSeq,
        contentDigest,
        provenanceDigest,
      }).slice(0, 32)}`
      const resource: BrowserWorkflowObservationResource = {
        resourceId,
        taskId: input.taskId,
        operationId: input.operationId,
        ownerRunId: input.ownerRunId,
        identity: receiptIdentity,
        mediaType: 'application/json',
        content: input.resourceContent,
        contentDigest,
        provenanceDigest,
        truncated: input.resourceTruncated,
        createdAt: observedAt,
      }
      const receiptId = `browser-observation-${browserWorkflowStableDigest({
        taskId: input.taskId,
        observationSeq,
        operationId: input.operationId,
        ownerRunId: input.ownerRunId,
        observedAfterActionSeq,
        identity: receiptIdentity,
        searchActionId: linkedSearch?.searchActionId || null,
        queryDigest: linkedSearch?.queryDigest || null,
        causalActions,
        resultDigest: input.resultDigest,
        resourceId,
      }).slice(0, 32)}`
      const receipt: BrowserWorkflowObservationReceipt = {
        receiptId,
        observationSeq,
        operationId: input.operationId,
        ownerRunId: input.ownerRunId,
        observedAfterActionSeq,
        identity: receiptIdentity,
        searchActionId: linkedSearch?.searchActionId || null,
        queryDigest: linkedSearch?.queryDigest || null,
        causalActions,
        resultDigest: input.resultDigest,
        resourceId,
        observedAt,
      }
      const nextJournal: BrowserWorkflowActionJournal = {
        nextActionSeq: journal.nextActionSeq,
        nextObservationSeq: observationSeq + 1,
        activeAction: null,
        settledOutcomes: journal.settledOutcomes,
        observationReceipts: [...journal.observationReceipts, receipt],
      }
      parseBrowserWorkflowActionJournal(
        { browserWorkflowActionJournal: nextJournal },
        input.taskId,
      )
      verifyBrowserObservationResource(input.taskId, resource, receipt)
      writeJournalPayload(db, row, {
        ...payload,
        browserWorkflowActionJournal: nextJournal,
        browserWorkflowObservationResources: [...resources, resource],
      })
      return receipt
    })
  }

  upsertBrowserResearchWorkItems(
    taskId: string,
    ownerRunId: string,
    inputs: BrowserResearchWorkItemInput[],
  ): BrowserResearchAssessment {
    if (inputs.length === 0) throw new Error('browser_research_work_items_required')
    if (inputs.length > 128) throw new Error('browser_research_work_items_too_large')
    return this.unitOfWork.runImmediate((db) => {
      const row = readJournalRow(db, taskId)
      assertCurrentOwnerAuthority(db, row, ownerRunId)
      const { payload } = readPayloadAndJournal(row)
      const state = parseBrowserResearchState(payload)
      const createdAt = new Date().toISOString()
      const nextById = new Map(state.workItems.map((item) => [item.workItemId, item]))
      // 2026-07-23 失忆回归修复：模型每波重注册计划会发明新的 id 命名法
      // （q01→kw-1→kw01→k01），同一内容以不同 id 反复 append，把必做清单
      // 从 18 项污染到 97 项。内容摘要相同（无关 id）视为同一工作项，静默
      // 合并到既有项，不再追加。
      const idByContentDigest = new Map(
        state.workItems.map((item) => [researchWorkItemContentDigest(item), item.workItemId]),
      )
      for (const input of inputs) {
        const next = stableBrowserResearchWorkItem(taskId, input, createdAt)
        const existing = nextById.get(next.workItemId)
        const nextContentDigest = researchWorkItemContentDigest(next)
        if (existing) {
          const existingContent = { ...existing, evidenceRefIds: [], createdAt: '' }
          const nextContent = { ...next, evidenceRefIds: [], createdAt: '' }
          if (browserWorkflowStableDigest(existingContent) !== browserWorkflowStableDigest(nextContent)) {
            throw new Error(`browser_research_work_item_conflict:${next.workItemId}`)
          }
          continue
        }
        if (idByContentDigest.has(nextContentDigest)) continue
        idByContentDigest.set(nextContentDigest, next.workItemId)
        nextById.set(next.workItemId, next)
      }
      const nextState: BrowserResearchPayloadState = {
        version: 1,
        workItems: Array.from(nextById.values()),
        evidenceRefs: state.evidenceRefs,
      }
      if (nextState.workItems.length > 512) {
        throw new Error('browser_research_work_items_total_too_large')
      }
      const assessment = assessBrowserResearch(taskId, nextState)
      writeJournalPayload(db, row, { ...payload, browserResearch: nextState }, {
        total: nextState.workItems.filter((item) => item.required).length,
        completed: nextState.workItems.filter((item) => item.required && item.evidenceRefIds.length > 0).length,
      })
      return assessment
    })
  }

  bindBrowserResearchEvidence(
    taskId: string,
    ownerRunId: string,
    bindings: BrowserResearchEvidenceBindingInput[],
  ): BrowserResearchAssessment {
    if (bindings.length === 0) throw new Error('browser_research_evidence_bindings_required')
    if (bindings.length > 256) throw new Error('browser_research_evidence_bindings_too_large')
    return this.unitOfWork.runImmediate((db) => {
      const row = readJournalRow(db, taskId)
      assertCurrentOwnerAuthority(db, row, ownerRunId)
      const { payload, journal } = readPayloadAndJournal(row)
      const state = parseBrowserResearchState(payload)
      const resources = new Map(
        parseBrowserWorkflowObservationResources(payload, taskId)
          .map((resource) => [resource.resourceId, resource]),
      )
      const items = new Map(state.workItems.map((item) => [
        item.workItemId,
        { ...item, evidenceRefIds: [...item.evidenceRefIds] },
      ]))
      const evidence = new Map(state.evidenceRefs.map((item) => [item.evidenceRefId, item]))
      const createdAt = new Date().toISOString()
      for (const requested of bindings) {
        const workItemId = browserResearchBoundedString(requested.workItemId, 256)
        const observationReceiptId = browserResearchBoundedString(requested.observationReceiptId, 256)
        const actionReceiptId = browserResearchBoundedString(requested.actionReceiptId, 256)
        if (!workItemId || !observationReceiptId) {
          throw new Error('browser_research_evidence_binding_invalid')
        }
        const item = items.get(workItemId)
        if (!item) throw new Error(`browser_research_work_item_not_found:${workItemId}`)
        const observation = journal.observationReceipts
          .find((receipt) => receipt.receiptId === observationReceiptId)
        if (!observation) {
          throw new Error(`browser_research_observation_receipt_not_found:${observationReceiptId}`)
        }
        const resource = resources.get(observation.resourceId)
        if (!resource || resource.taskId !== taskId) {
          throw new Error(`browser_research_observation_resource_not_found:${observation.resourceId}`)
        }
        verifyBrowserObservationResource(taskId, resource, observation)
        const action = actionReceiptId
          ? journal.settledOutcomes.find((receipt) => receipt.receiptId === actionReceiptId)
          : null
        if (actionReceiptId && !action) {
          throw new Error(`browser_research_action_receipt_not_found:${actionReceiptId}`)
        }
        if (action) {
          const causal = observation.causalActions
            .find((candidate) => candidate.actionId === action.actionId)
          if (!causal || causal.actionSeq !== action.actionSeq) {
            throw new Error('browser_research_evidence_not_causally_bound')
          }
        }
        const evidenceRefId = `browser-research-evidence-${browserWorkflowStableDigest({
          taskId,
          workItemId,
          observationReceiptId,
          actionReceiptId,
        }).slice(0, 32)}`
        if (evidence.has(evidenceRefId)) continue
        const evidenceRef: BrowserResearchEvidenceRef = {
          evidenceRefId,
          workItemId,
          observationReceiptId,
          actionReceiptId: actionReceiptId || null,
          observationSeq: observation.observationSeq,
          actionSeq: action?.actionSeq ?? null,
          operationId: observation.operationId,
          resultDigest: observation.resultDigest,
          resourceId: resource.resourceId,
          contentDigest: resource.contentDigest,
          provenanceDigest: resource.provenanceDigest,
          identity: observation.identity,
          createdAt,
        }
        evidence.set(evidenceRefId, evidenceRef)
        item.evidenceRefIds.push(evidenceRefId)
      }
      const nextState: BrowserResearchPayloadState = {
        version: 1,
        workItems: Array.from(items.values()),
        evidenceRefs: Array.from(evidence.values()),
      }
      if (nextState.evidenceRefs.length > 4_096) {
        throw new Error('browser_research_evidence_limit_reached')
      }
      const assessment = assessBrowserResearch(taskId, nextState)
      writeJournalPayload(db, row, { ...payload, browserResearch: nextState }, {
        total: nextState.workItems.filter((item) => item.required).length,
        completed: nextState.workItems.filter((item) => item.required && item.evidenceRefIds.length > 0).length,
      })
      return assessment
    })
  }
}
