import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { BrowserTaskPersistenceService } from '../main/modules/browser-engine/task-persistence-service'
import {
  browserObservationProvenanceDigest,
  browserWorkflowStableDigest,
} from '../main/modules/browser-engine/browser-workflow-evidence'

interface FakeBrowserTaskRecord {
  id: string
  kind: string
  status: string
  payload_json: string
  checkpoint_json: string | null
  result_json: string | null
  progress_total: number
  progress_completed: number
  progress_failed: number
  current_label: string | null
  error: string | null
  created_at: string
  started_at: string | null
  updated_at: string
  finished_at: string | null
  revision?: number
  created_by_run_id?: string | null
  active_execution_binding_json?: string | null
  parent_task_id?: string | null
  projection_revision?: number
  projection_sync_json?: string | null
}

class FakeBrowserRepository {
  readonly tasks = new Map<string, FakeBrowserTaskRecord>()
  beforeUpdate: ((id: string) => void) | null = null

  createTask(task: FakeBrowserTaskRecord): void {
    this.tasks.set(task.id, { ...task })
  }

  getTask(id: string): FakeBrowserTaskRecord | undefined {
    const task = this.tasks.get(id)
    return task ? { ...task } : undefined
  }

  updateTask(
    id: string,
    updates: Partial<FakeBrowserTaskRecord>,
    options?: { expectedUpdatedAt?: string },
  ): boolean {
    const beforeUpdate = this.beforeUpdate
    this.beforeUpdate = null
    beforeUpdate?.(id)
    const current = this.tasks.get(id)
    if (!current) return false
    if (options?.expectedUpdatedAt && current.updated_at !== options.expectedUpdatedAt) return false
    const clean = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ) as Partial<FakeBrowserTaskRecord>
    this.tasks.set(id, { ...current, ...clean })
    return true
  }

  listTasks(statuses?: string[]): FakeBrowserTaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => !statuses || statuses.includes(task.status))
      .map((task) => ({ ...task }))
  }
}

function makeRecord(id: string): FakeBrowserTaskRecord {
  return {
    id,
    kind: 'note_collect',
    status: 'queued',
    payload_json: '{}',
    checkpoint_json: null,
    result_json: null,
    progress_total: 0,
    progress_completed: 0,
    progress_failed: 0,
    current_label: null,
    error: null,
    created_at: '2026-06-21T00:00:00.000Z',
    started_at: null,
    updated_at: '2026-06-21T00:00:00.000Z',
    finished_at: null,
  }
}

function makeWorkflowRecord(id: string, ownerRunId: string): FakeBrowserTaskRecord {
  return {
    ...makeRecord(id),
    kind: 'browser_workflow',
    status: 'running',
    payload_json: JSON.stringify({
      browserWorkflowActionJournal: {
        nextActionSeq: 1,
        nextObservationSeq: 1,
        activeAction: null,
        settledOutcomes: [],
        observationReceipts: [],
      },
    }),
    active_execution_binding_json: JSON.stringify({ runId: ownerRunId }),
    parent_task_id: `parent-${id}`,
  }
}

function makeWorkflowService(repository: FakeBrowserRepository): BrowserTaskPersistenceService {
  return new BrowserTaskPersistenceService(repository as never)
}

function workflowEvidenceFixture(
  taskId: string,
  options: {
    includeAction?: boolean
    observeAction?: boolean
    research?: 'none' | 'incomplete' | 'satisfied'
  } = {},
) {
  const ownerRunId = `run-${taskId}`
  const identity = {
    documentState: 'document' as const,
    tabId: `tab-${taskId}`,
    physicalTargetToken: `physical-${taskId}`,
    frameId: '0',
    frameDocumentToken: `document-${taskId}`,
    targetRef: null,
  }
  const actionId = `browser-action-${taskId}`
  const outcome = {
    actionId,
    actionSeq: 1,
    taskId,
    ownerRunId,
    operationId: 'click_coordinate' as const,
    mode: 'mutate' as const,
    dispatch: 'accepted' as const,
    delivery: 'delivered' as const,
    effect: 'unknown' as const,
    needsObservation: true,
    mayHaveCommitted: true,
    identity,
    successorIdentity: identity,
  }
  const actionReceiptId = `browser-receipt-${browserWorkflowStableDigest({
    taskId,
    actionId,
    normalizedOutcome: outcome,
  }).slice(0, 32)}`
  const settledAction = {
    receiptId: actionReceiptId,
    actionId,
    actionSeq: 1,
    outcome,
    settledAt: '2026-07-18T00:00:00.000Z',
  }
  const causalActions = options.includeAction && options.observeAction
    ? [{
        actionId,
        actionSeq: 1,
        predecessorIdentity: identity,
        successorIdentity: identity,
        searchActionId: null,
        queryDigest: null,
      }]
    : []
  const content = JSON.stringify({ operationId: 'snapshot', result: { content: `evidence-${taskId}` } })
  const resultDigest = browserWorkflowStableDigest(JSON.parse(content))
  const observedAt = '2026-07-18T00:00:01.000Z'
  const contentDigest = createHash('sha256').update(content).digest('hex')
  const provenanceDigest = browserObservationProvenanceDigest(taskId, {
    operationId: 'snapshot',
    ownerRunId,
    identity,
    resultDigest,
    observedAt,
  })
  const resourceId = `browser-observation-resource-${browserWorkflowStableDigest({
    taskId,
    observationSeq: 1,
    contentDigest,
    provenanceDigest,
  }).slice(0, 32)}`
  const observationReceipt = {
    receiptId: '',
    observationSeq: 1,
    operationId: 'snapshot' as const,
    ownerRunId,
    observedAfterActionSeq: causalActions.length > 0 ? 1 : 0,
    identity,
    searchActionId: null,
    queryDigest: null,
    causalActions,
    resultDigest,
    resourceId,
    observedAt,
  }
  observationReceipt.receiptId = `browser-observation-${browserWorkflowStableDigest({
    taskId,
    observationSeq: observationReceipt.observationSeq,
    operationId: observationReceipt.operationId,
    ownerRunId: observationReceipt.ownerRunId,
    observedAfterActionSeq: observationReceipt.observedAfterActionSeq,
    identity: observationReceipt.identity,
    searchActionId: observationReceipt.searchActionId,
    queryDigest: observationReceipt.queryDigest,
    causalActions: observationReceipt.causalActions,
    resultDigest: observationReceipt.resultDigest,
    resourceId: observationReceipt.resourceId,
  }).slice(0, 32)}`
  const resource = {
    resourceId,
    taskId,
    operationId: 'snapshot' as const,
    ownerRunId,
    identity,
    mediaType: 'application/json' as const,
    content,
    contentDigest,
    provenanceDigest,
    truncated: false,
    createdAt: observedAt,
  }
  const research = options.research || 'none'
  const workItemId = `research-${taskId}`
  const evidenceRefId = `browser-research-evidence-${browserWorkflowStableDigest({
    taskId,
    workItemId,
    observationReceiptId: observationReceipt.receiptId,
    actionReceiptId: null,
  }).slice(0, 32)}`
  const browserResearch = research === 'none'
    ? undefined
    : {
        version: 1,
        workItems: [{
          workItemId,
          goalRefs: ['goal-open-ended-research'],
          requirement: '未知语言の独自指标を調べる',
          query: null,
          url: null,
          fieldGoals: ['свободное поле', 'مؤشر غير معروف'],
          required: true,
          evidenceRefIds: research === 'satisfied' ? [evidenceRefId] : [],
          createdAt: '2026-07-18T00:00:00.000Z',
        }],
        evidenceRefs: research === 'satisfied'
          ? [{
              evidenceRefId,
              workItemId,
              observationReceiptId: observationReceipt.receiptId,
              actionReceiptId: null,
              observationSeq: 1,
              actionSeq: null,
              operationId: 'snapshot',
              resultDigest,
              resourceId,
              contentDigest,
              provenanceDigest,
              identity,
              createdAt: '2026-07-18T00:00:02.000Z',
            }]
          : [],
      }
  return {
    actionReceiptId,
    observationReceipt,
    resource,
    payload: {
      browserWorkflowActionJournal: {
        nextActionSeq: options.includeAction ? 2 : 1,
        nextObservationSeq: 2,
        activeAction: null,
        settledOutcomes: options.includeAction ? [settledAction] : [],
        observationReceipts: [observationReceipt],
      },
      browserWorkflowObservationResources: [resource],
      ...(browserResearch ? { browserResearch } : {}),
    },
  }
}

describe('browser task persistence', () => {
  it('fails closed instead of resetting corrupt workflow payloads, journals, or resources', () => {
    const repository = new FakeBrowserRepository()
    const service = makeWorkflowService(repository)

    const invalidPayloadId = 'browser-workflow-invalid-payload'
    repository.createTask({ ...makeWorkflowRecord(invalidPayloadId, 'run-corrupt'), payload_json: '{' })
    assert.throws(() => service.getTaskPayload(invalidPayloadId), /browser_workflow_payload_corrupt/)

    const invalidJournalId = 'browser-workflow-invalid-journal'
    repository.createTask({
      ...makeWorkflowRecord(invalidJournalId, 'run-corrupt'),
      payload_json: JSON.stringify({
        browserWorkflowActionJournal: {
          nextActionSeq: 0,
          nextObservationSeq: 1,
          activeAction: null,
          settledOutcomes: [],
          observationReceipts: [],
        },
      }),
    })
    assert.throws(
      () => service.readVerifiedWorkflowEvidence(invalidJournalId),
      /browser_workflow_persisted_state_corrupt:actionJournal.nextActionSeq/,
    )

    const invalidResourceId = 'browser-workflow-invalid-resource'
    repository.createTask({
      ...makeWorkflowRecord(invalidResourceId, 'run-corrupt'),
      payload_json: JSON.stringify({
        browserWorkflowActionJournal: {
          nextActionSeq: 1,
          nextObservationSeq: 1,
          activeAction: null,
          settledOutcomes: [],
          observationReceipts: [],
        },
        browserWorkflowObservationResources: [null],
      }),
    })
    assert.throws(
      () => service.readVerifiedWorkflowEvidence(invalidResourceId),
      /browser_workflow_persisted_state_corrupt:observationResources\[0\]/,
    )
  })

  it('verifies ordinary observations without inventing research and blocks unobserved mutations', () => {
    const repository = new FakeBrowserRepository()
    const service = makeWorkflowService(repository)
    const taskId = 'browser-workflow-general-evidence'
    const ordinaryFixture = workflowEvidenceFixture(taskId)
    repository.createTask({
      ...makeWorkflowRecord(taskId, `run-${taskId}`),
      payload_json: JSON.stringify(ordinaryFixture.payload),
    })

    const ordinary = service.readVerifiedWorkflowEvidence(taskId)
    assert.equal(ordinary.researchState, 'not_requested')
    assert.equal(ordinary.researchAssessment, null)
    assert.equal(ordinary.unresolvedActions.length, 0)
    assert.deepEqual(ordinary.resources.map((item) => item.resourceId), [ordinaryFixture.resource.resourceId])
    assert.equal(service.readHighestSettledAction(taskId), null)
    assert.equal(service.readHighestObservation(taskId)?.receiptId, ordinaryFixture.observationReceipt.receiptId)
    assert.equal(
      service.readObservationResource(taskId, ordinaryFixture.resource.resourceId)?.resourceId,
      ordinaryFixture.resource.resourceId,
    )
    assert.deepEqual(
      service.listObservationResources(taskId).map((resource) => resource.resourceId),
      [ordinaryFixture.resource.resourceId],
    )

    assert.equal(service.updateTaskPayload(taskId, { unrelated: 'fresh-writer' }), true)
    assert.equal(service.readHighestObservation(taskId)?.receiptId, ordinaryFixture.observationReceipt.receiptId)

    const unresolvedFixture = workflowEvidenceFixture(taskId, { includeAction: true })
    const current = repository.tasks.get(taskId)!
    repository.tasks.set(taskId, { ...current, payload_json: JSON.stringify(unresolvedFixture.payload) })
    const unresolved = service.readVerifiedWorkflowEvidence(taskId)
    assert.equal(unresolved.unresolvedActions.length, 1)
    assert.equal(service.readHighestSettledAction(taskId)?.receiptId, unresolvedFixture.actionReceiptId)

    const observedFixture = workflowEvidenceFixture(taskId, { includeAction: true, observeAction: true })
    repository.tasks.set(taskId, { ...current, payload_json: JSON.stringify(observedFixture.payload) })
    assert.equal(service.readVerifiedWorkflowEvidence(taskId).unresolvedActions.length, 0)
  })

  it('fails closed for incomplete or malformed explicit research state', () => {
    const repository = new FakeBrowserRepository()
    const service = makeWorkflowService(repository)
    const taskId = 'browser-workflow-research-proof-gap'
    const fixture = workflowEvidenceFixture(taskId, { research: 'incomplete' })
    repository.createTask({
      ...makeWorkflowRecord(taskId, `run-${taskId}`),
      payload_json: JSON.stringify(fixture.payload),
    })

    const incomplete = service.readVerifiedWorkflowEvidence(taskId)
    assert.equal(incomplete.researchState, 'incomplete')
    assert.deepEqual(incomplete.researchAssessment?.missingWorkItemIds, [`research-${taskId}`])

    const current = repository.tasks.get(taskId)!
    const malformed = JSON.parse(current.payload_json) as Record<string, unknown>
    malformed.browserResearch = { version: 1, workItems: [null], evidenceRefs: [] }
    repository.tasks.set(taskId, { ...current, payload_json: JSON.stringify(malformed) })
    assert.throws(
      () => service.readVerifiedWorkflowEvidence(taskId),
      /browser_workflow_persisted_state_corrupt:browserResearch\.workItems\[0\]/,
    )
  })

  it('verifies open-ended research evidence and rejects provenance or content tampering', () => {
    const repository = new FakeBrowserRepository()
    const service = makeWorkflowService(repository)
    const taskId = 'browser-workflow-research'
    const fixture = workflowEvidenceFixture(taskId, { research: 'satisfied' })
    repository.createTask({
      ...makeWorkflowRecord(taskId, `run-${taskId}`),
      payload_json: JSON.stringify(fixture.payload),
    })

    assert.equal(service.assessResearch(taskId).satisfied, true)
    const verifierBundle = service.readVerifiedWorkflowEvidence(taskId)
    assert.equal(verifierBundle.researchState, 'satisfied')
    assert.equal(verifierBundle.researchAssessment?.workItems[0]?.goalRefs[0], 'goal-open-ended-research')
    assert.deepEqual(verifierBundle.resources.map((resource) => resource.resourceId), [fixture.resource.resourceId])

    const persisted = repository.tasks.get(taskId)!
    const originalPayload = persisted.payload_json
    const provenanceTampered = JSON.parse(originalPayload) as {
      browserWorkflowObservationResources: Array<{ provenanceDigest: string }>
    }
    provenanceTampered.browserWorkflowObservationResources[0]!.provenanceDigest = 'tampered-provenance'
    repository.tasks.set(taskId, { ...persisted, payload_json: JSON.stringify(provenanceTampered) })
    assert.throws(
      () => service.readVerifiedWorkflowEvidence(taskId),
      /browser_observation_resource_provenance_digest_mismatch/,
    )

    const contentTampered = JSON.parse(originalPayload) as {
      browserWorkflowObservationResources: Array<{ content: string }>
    }
    contentTampered.browserWorkflowObservationResources[0]!.content = JSON.stringify({ content: 'tampered' })
    repository.tasks.set(taskId, { ...persisted, payload_json: JSON.stringify(contentTampered) })
    assert.throws(
      () => service.readVerifiedWorkflowEvidence(taskId),
      /browser_observation_resource_content_digest_mismatch/,
    )
  })
})
