import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import type { BrowserCapabilityTaskStatus } from '../main/modules/browser-engine/capability-types'
import { BrowserTaskPersistenceService } from '../main/modules/browser-engine/task-persistence-service'
import {
  browserObservationProvenanceDigest,
  browserWorkflowStableDigest,
} from '../main/modules/browser-engine/browser-workflow-evidence'
import { taskEventBridge, type TaskEventBridgePayload } from '../main/modules/browser-engine/task-event-bridge'
import type { DatabaseManager as DatabaseManagerInstance } from '../main/modules/database'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

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

  it('publishes only mapped browser task statuses to the task event bridge', () => {
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    const events: TaskEventBridgePayload[] = []
    const unregister = taskEventBridge.registerProjectionSink((payload) => {
      if (payload.taskId.startsWith('browser-task-publish-map-')) events.push(payload)
    })
    const statuses: BrowserCapabilityTaskStatus[] = [
      'queued',
      'running',
      'waiting_human',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ]

    try {
      for (const status of statuses) {
        const taskId = `browser-task-publish-map-${status}`
        repository.createTask(makeRecord(taskId))
        const updated = service.updateProgress(taskId, {}, { status })
        assert.equal(updated?.status, status)
      }

      assert.deepEqual(
        events.map((event) => [event.taskId, event.status]),
        [
          ['browser-task-publish-map-waiting_human', 'waiting_human'],
          ['browser-task-publish-map-paused', 'paused'],
          ['browser-task-publish-map-completed', 'completed'],
          ['browser-task-publish-map-failed', 'failed'],
        ],
      )
      for (const event of events) {
        assert.equal((event.extra as { taskId?: string } | null)?.taskId, event.taskId)
      }
    } finally {
      unregister()
    }
  })

  it('publishes scoped sanitized pause summaries for browser collection terminal events', () => {
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    const taskId = 'browser-task-publish-sanitized-max-duration'
    repository.createTask({
      ...makeRecord(taskId),
      payload_json: JSON.stringify({
        scopeId: 'scope-browser-collection',
        messageVisibilityEpoch: 7,
        plan: {
          sourceTaskId: 'browser-task-visible-source',
          outputRootDir: '/tmp/ready-out',
          notes: [
            { url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=secret-token', title: 'note' },
          ],
        },
      }),
    })
    const events: TaskEventBridgePayload[] = []
    const unregister = taskEventBridge.registerProjectionSink((payload) => {
      if (payload.taskId === taskId) events.push(payload)
    })

    try {
      service.updateProgress(taskId, {
        total: 179,
        completed: 169,
        failed: 0,
        currentLabel: null,
      }, {
        status: 'paused',
        checkpoint: {
          taskId,
          stage: 'note_collect_round',
          cursor: '169',
          partialResults: { cursor: 169 },
        } as never,
        result: {
          stopReason: 'max_duration',
          sourceTaskId: 'browser-task-visible-source',
          outputRootDir: '/tmp/ready-out',
          remaining: 10,
          resumeFromCursor: 169,
          autoContinue: true,
        },
        startedAt: '2026-07-01T00:00:00.000Z',
        finishedAt: '2026-07-01T00:20:00.000Z',
      })

      assert.equal(events.length, 1)
      const extra = events[0].extra as Record<string, unknown>
      assert.equal(events[0].status, 'paused')
      assert.equal(extra.scopeId, 'scope-browser-collection')
      assert.equal(extra.messageVisibilityEpoch, 7)
      assert.equal(extra.browserTaskId, taskId)
      assert.equal(extra.sourceTaskId, 'browser-task-visible-source')
      assert.equal(extra.stopReason, 'max_duration')
      assert.equal(extra.autoContinue, true)
      assert.equal(extra.canResume, true)
      assert.equal(extra.summary, '单段运行保护暂停：已保存 169/179，剩余 10')
      assert.deepEqual(extra.progress, {
        total: 179,
        completed: 169,
        failed: 0,
        remaining: 10,
        currentLabel: null,
      })
      const serialized = JSON.stringify(extra)
      assert.doesNotMatch(serialized, /xsec_token/)
      assert.doesNotMatch(serialized, /secret-token/)
      assert.doesNotMatch(serialized, /xiaohongshu\.com\/explore\/n1/)
    } finally {
      unregister()
    }
  })

  it('keeps waiting_human out of startup pending tasks while visible supervision handles it separately', () => {
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    for (const status of ['queued', 'running', 'paused', 'waiting_human', 'completed'] as const) {
      repository.createTask({ ...makeRecord(`browser-task-${status}`), status })
    }

    assert.deepEqual(
      service.listPendingTasks().map((task) => task.status),
      ['queued', 'running', 'paused'],
    )
  })

  it('uses a terminal CAS so a late completion cannot overwrite cancellation', () => {
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    const taskId = 'browser-task-cancel-race'
    repository.createTask({
      ...makeRecord(taskId),
      status: 'running',
      result_json: JSON.stringify({ partial: true }),
    })
    repository.beforeUpdate = (id) => {
      const current = repository.tasks.get(id)!
      repository.tasks.set(id, {
        ...current,
        status: 'cancelled',
        updated_at: '2026-06-21T00:00:01.000Z',
        finished_at: '2026-06-21T00:00:01.000Z',
      })
    }

    const late = service.updateProgress(taskId, { completed: 1 }, {
      status: 'completed',
      result: { partial: false, late: true },
      finishedAt: '2026-06-21T00:00:02.000Z',
    })

    assert.equal(late?.status, 'cancelled')
    assert.deepEqual(late?.result, { partial: true })
    assert.equal(late?.progress.completed, 0)
  })

  it('clears nullable progress fields explicitly and reports payload CAS conflicts', () => {
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    const taskId = 'browser-task-null-clear'
    repository.createTask({
      ...makeRecord(taskId),
      status: 'running',
      current_label: 'working',
      error: 'old error',
      payload_json: JSON.stringify({ scopeId: 'scope-a' }),
    })

    const cleared = service.updateProgress(taskId, { currentLabel: null }, { error: null })
    assert.equal(cleared?.progress.currentLabel, null)
    assert.equal(cleared?.error, null)

    repository.beforeUpdate = (id) => {
      const current = repository.tasks.get(id)!
      repository.tasks.set(id, { ...current, updated_at: '2026-06-21T00:00:02.000Z' })
    }
    assert.equal(service.updateTaskPayload(taskId, { scopeId: 'scope-b' }), false)
    assert.deepEqual(service.getTaskPayload(taskId), { scopeId: 'scope-a' })
  })

  it('patches payload fields without replacing unrelated state and fails closed on a concurrent update', () => {
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    const taskId = 'browser-task-payload-patch'
    repository.createTask({
      ...makeRecord(taskId),
      payload_json: JSON.stringify({ scopeId: 'scope-a', agentTabId: 'tab-old' }),
    })

    assert.equal(service.patchTaskPayload(taskId, { ownerRunId: 'run-new' }), true)
    assert.deepEqual(service.getTaskPayload(taskId), {
      scopeId: 'scope-a',
      agentTabId: 'tab-old',
      ownerRunId: 'run-new',
    })

    repository.beforeUpdate = (id) => {
      const current = repository.tasks.get(id)!
      repository.tasks.set(id, {
        ...current,
        payload_json: JSON.stringify({ scopeId: 'scope-a', agentTabId: 'tab-newer' }),
        updated_at: '2026-06-21T00:00:02.000Z',
      })
    }
    assert.equal(service.patchTaskPayload(taskId, { ownerRunId: 'run-late' }), false)
    assert.deepEqual(service.getTaskPayload(taskId), { scopeId: 'scope-a', agentTabId: 'tab-newer' })
  })

  it('changes a grounded payload and checkpoint in one CAS or leaves both untouched', () => {
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    const taskId = 'browser-task-grounded-state-cas'
    repository.createTask({
      ...makeRecord(taskId),
      kind: 'browser_workflow',
      status: 'running',
      payload_json: JSON.stringify({ groundedRequestKey: 'old-key' }),
      checkpoint_json: JSON.stringify({
        taskId,
        stage: 'browser_workflow',
        cursor: '0',
        partialResults: { version: 2, requestKey: 'old-key', queries: [], receipts: [] },
      }),
    })
    const initial = service.getTask(taskId)
    assert.ok(initial?.updatedAt)
    repository.beforeUpdate = (id) => {
      const current = repository.tasks.get(id)!
      repository.tasks.set(id, { ...current, updated_at: '2026-06-21T00:00:02.000Z' })
    }
    const conflicted = service.compareAndSetTaskState(taskId, initial.updatedAt, {
      payload: { groundedRequestKey: 'new-key' },
      checkpoint: {
        taskId,
        stage: 'browser_workflow',
        cursor: '0',
        partialResults: { version: 2, requestKey: 'new-key', queries: [], receipts: [] },
      },
    })
    assert.equal(conflicted.committed, false)
    assert.equal(service.getTaskPayload(taskId)?.groundedRequestKey, 'old-key')
    assert.equal((service.getTask(taskId)?.checkpoint?.partialResults as { requestKey?: string })?.requestKey, 'old-key')

    const latest = service.getTask(taskId)
    assert.ok(latest?.updatedAt)
    const committed = service.compareAndSetTaskState(taskId, latest.updatedAt, {
      payload: { groundedRequestKey: 'new-key' },
      checkpoint: {
        taskId,
        stage: 'browser_workflow',
        cursor: '0',
        partialResults: { version: 2, requestKey: 'new-key', queries: [], receipts: [] },
      },
    })
    assert.equal(committed.committed, true)
    assert.equal(service.getTaskPayload(taskId)?.groundedRequestKey, 'new-key')
    assert.equal((committed.task?.checkpoint?.partialResults as { requestKey?: string })?.requestKey, 'new-key')
  })

  it('keeps projection revisions monotonic and exposes a concurrent sync conflict', () => {
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    const taskId = 'browser-task-projection-sync'
    repository.createTask({
      ...makeRecord(taskId),
      revision: 5,
      projection_revision: 4,
      projection_sync_json: null,
    })

    const monotonic = service.updateProjectionSync(taskId, {
      projectionRevision: 2,
      sync: null,
    })
    assert.equal(monotonic?.projectionRevision, 4)

    repository.beforeUpdate = (id) => {
      const current = repository.tasks.get(id)!
      repository.tasks.set(id, {
        ...current,
        revision: 6,
        updated_at: '2026-06-21T00:00:02.000Z',
      })
    }
    const conflicted = service.updateProjectionSync(taskId, {
      projectionRevision: 5,
      sync: null,
    })
    assert.equal(conflicted?.revision, 6)
    assert.equal(conflicted?.projectionRevision, 4)
  })

  it('persists a complete resume checkpoint contract with targets, failures, hashes, binding and next step', () => {
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    const taskId = 'browser-task-checkpoint-contract'
    repository.createTask({
      ...makeRecord(taskId),
      status: 'running',
      payload_json: JSON.stringify({
        agentTabId: 'tab-agent-7',
        documentEpoch: 9,
        plan: {
          notes: [
            { sourceId: 'note-a', url: 'https://example.com/a' },
            { sourceId: 'note-b', url: 'https://example.com/b' },
          ],
        },
      }),
    })

    const updated = service.updateProgress(taskId, { completed: 1, failed: 1 }, {
      status: 'paused',
      checkpoint: {
        taskId,
        stage: 'note_collect_round',
        cursor: '1',
        partialResults: {
          outputs: [{ sourceId: 'note-a', success: true, files: ['/out/a.md'] }],
          failed: [{ sourceId: 'note-b', status: 429, retryable: true }],
        },
      },
    })

    assert.deepEqual(updated?.checkpoint?.targetList, [
      { id: 'note-a', url: 'https://example.com/a' },
      { id: 'note-b', url: 'https://example.com/b' },
    ])
    assert.deepEqual(updated?.checkpoint?.failures, [
      { targetId: 'note-b', classification: 'rate_limit', retryable: true },
    ])
    assert.equal(updated?.checkpoint?.outputHashes?.[0]?.targetId, 'note-a')
    assert.match(updated?.checkpoint?.outputHashes?.[0]?.sha256 || '', /^[a-f0-9]{64}$/)
    assert.deepEqual(updated?.checkpoint?.binding, { tabId: 'tab-agent-7', documentEpoch: 9 })
    assert.deepEqual(updated?.checkpoint?.nextStep, { action: 'resume', cursor: '1' })
  })

  it('does not include undefined fields in browser task update SQL', async () => {
    const { DatabaseManager } = await import('../main/modules/database')
    let sql = ''
    let params: unknown[] = []
    const fakeManager = {
      db: {
        prepare: (source: string) => ({
          run: (...args: unknown[]) => {
            sql = source
            params = args
            return { changes: 1 }
          },
        }),
      },
    }

    DatabaseManager.prototype.updateBrowserTask.call(fakeManager as never, 'browser-task-1', {
      status: 'cancelled',
      checkpoint_json: undefined,
      result_json: undefined,
      progress_completed: 3,
    })

    assert.match(sql, /status = \?/)
    assert.match(sql, /progress_completed = \?/)
    assert.doesNotMatch(sql, /checkpoint_json = \?/)
    assert.doesNotMatch(sql, /result_json = \?/)
    assert.equal(params[0], 'cancelled')
    assert.equal(params[1], 3)
    assert.equal(params[params.length - 1], 'browser-task-1')
  })

  it('preserves existing result and checkpoint when an update omits those fields', async (t) => {
    if (skipIfSqliteUnavailable(t, 'browser-task-persistence: preserve omitted fields')) return
    const { DatabaseManager, DatabaseUnavailableError } = await import('../main/modules/database')
    let db: DatabaseManagerInstance | null = null

    try {
      db = new DatabaseManager(true)
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) {
        t.skip('better-sqlite3 native binding unavailable in this Node runtime')
        return
      }
      throw error
    }

    try {
      db.createBrowserTask({
        id: 'browser-task-preserve',
        kind: 'note_collect',
        status: 'running',
        payload_json: '{}',
        checkpoint_json: JSON.stringify({ stage: 'note_collect_round', cursor: '1' }),
        result_json: JSON.stringify({ collected: ['https://example.com/1'] }),
        progress_total: 2,
        progress_completed: 1,
        progress_failed: 0,
        current_label: 'note 1',
        error: null,
        created_at: '2026-06-05T00:00:00.000Z',
        started_at: '2026-06-05T00:00:00.000Z',
        updated_at: '2026-06-05T00:00:00.000Z',
        finished_at: null,
      })

      db.updateBrowserTask('browser-task-preserve', {
        status: 'cancelled',
        progress_completed: 1,
        current_label: null,
        finished_at: '2026-06-05T00:00:01.000Z',
      })

      const record = db.getBrowserTask('browser-task-preserve')
      assert.ok(record)
      assert.equal(record.status, 'cancelled')
      assert.equal(record.result_json, JSON.stringify({ collected: ['https://example.com/1'] }))
      assert.equal(record.checkpoint_json, JSON.stringify({ stage: 'note_collect_round', cursor: '1' }))
    } finally {
      db?.close()
    }
  })
})
