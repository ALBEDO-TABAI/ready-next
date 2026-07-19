import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import type { TaskExecutionBinding } from '../shared/agent-execution-profile'
import type { DeliveryStateV1, WorkPackage } from '../shared/dynamic-delivery'
import type { TaskProjectionRecord, TaskProjectionChangeEvent } from '../main/modules/agent-control/contracts/run-contracts'
import { DynamicDeliveryTaskStore, deliveryAttemptIdentity } from '../main/modules/agent-control/runtime-core/dynamic-delivery/dynamic-delivery-task-store'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const requireFromHere = createRequire(import.meta.url)
const now = '2026-07-11T00:00:00.000Z'

function createSchema(db: { exec(sql: string): void }): void {
  db.exec(`
    CREATE TABLE task_projections (
      task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
      dependency_generation INTEGER NOT NULL DEFAULT 0, scope_id TEXT NOT NULL, run_id TEXT NOT NULL,
      parent_task_id TEXT, parent_step_id TEXT, task_type TEXT NOT NULL, module TEXT NOT NULL,
      task_title TEXT, task_summary TEXT, status TEXT NOT NULL, interaction_state TEXT NOT NULL,
      waiting_for TEXT, steps_json TEXT NOT NULL, current_step_id TEXT, budget_json TEXT,
      budget_usage_percent INTEGER, budget_warning_level TEXT, recovery_history_json TEXT,
      degradation_reason TEXT, blocked_reason TEXT, resumable_actions_json TEXT,
      continuation_ref_json TEXT, progress_json TEXT, recent_artifacts_json TEXT,
      criteria_json TEXT, checkins_json TEXT, proof_refs_json TEXT, learning_refs_json TEXT,
      model_criteria_json TEXT, expected_outputs_json TEXT, owner_agent_id TEXT,
      task_origin TEXT, execution_binding_json TEXT, packet_role TEXT, context_refs_json TEXT,
      delivery_state_json TEXT, request_anchor_json TEXT, goal_mutations_json TEXT,
      steering_receipts_json TEXT, human_takeover_ref_json TEXT, checkpoint_refs_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE browser_tasks (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_task_id TEXT
    );
  `)
}

function binding(runId: string, effectiveAgentId = 'analyst'): TaskExecutionBinding {
  return {
    schemaVersion: 1, runId, ownerAgentIdAtStart: 'butler', runOrigin: 'workflow_participant',
    kind: 'registered_agent', requestedAgentId: effectiveAgentId, effectiveAgentId,
    executionMaterialHash: `hash-${effectiveAgentId}`, ownerAssignmentSource: 'parent_task',
    executionSelectionSource: 'workflow_participant', resolutionKind: 'direct',
  }
}

function projection(overrides: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: 'parent', scopeId: 'scope', runId: 'run-parent', parentTaskId: null, parentStepId: null,
    taskType: 'research', module: 'agent', taskTitle: 'Parent', taskSummary: '', status: 'running',
    interactionState: 'running', steps: [], ownerAgentId: 'butler', taskOrigin: 'user_root',
    executionBinding: binding('run-parent', 'butler'), createdAt: now, updatedAt: now,
    ...overrides,
  }
}

function state(): DeliveryStateV1 {
  return {
    version: 1, stateRevision: 0, decision: 'support_and_verify', parentGeneration: 4,
    packages: [
      {
        packageId: 'pkg-a', attempt: 0, childTaskId: 'child-a', lifecycleId: 'life-a', binding: binding('run-a'),
        criticality: 'required', status: 'running', adoptedByOwner: null, evidenceHandleIds: [],
      },
      {
        packageId: 'pkg-b', attempt: 0, childTaskId: 'child-b', lifecycleId: 'life-b', binding: binding('run-b'),
        criticality: 'required', status: 'running', adoptedByOwner: null, evidenceHandleIds: [],
      },
    ],
    verifier: { status: 'pending', repaired: false },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, usageSource: 'missing', providerCallCount: 0, missingCallCount: 0 },
  }
}

function openHarness(t: test.TestContext) {
  if (skipIfSqliteUnavailable(t, 'dynamic delivery task store real sqlite')) return null
  const mod = requireFromHere('better-sqlite3') as { default?: new (path: string) => any } | (new (path: string) => any)
  const Sqlite = 'default' in mod && mod.default ? mod.default : mod
  const db = new Sqlite(':memory:')
  createSchema(db)
  const repository = new TaskProjectionRepository({ getRawDb: () => db } as never)
  t.after(() => db.close())
  return { db, repository }
}

test('atomic delivery tree rolls back parent and inserted children with zero change event on child failure', (t) => {
  const harness = openHarness(t)
  if (!harness) return
  harness.repository.create(projection())
  const events: TaskProjectionChangeEvent[] = []
  harness.repository.on('change', (event) => events.push(event))

  const validChild = projection({
    taskId: 'child-a', runId: 'run-a', parentTaskId: 'parent', taskOrigin: 'workflow_child',
    ownerAgentId: 'butler', executionBinding: binding('run-a'), packetRole: 'child', contextRefs: ['resource:a'],
  })
  const invalidChild = projection({
    taskId: 'child-b', runId: 'run-b', parentTaskId: 'wrong-parent', taskOrigin: 'workflow_child',
    ownerAgentId: 'butler', executionBinding: binding('run-b'), packetRole: 'child', contextRefs: ['resource:b'],
  })

  assert.throws(() => harness.repository.createDeliveryTreeAtomic({
    parentTaskId: 'parent', deliveryState: state(), children: [validChild, invalidChild],
  }), /must belong/)
  assert.equal(harness.repository.get('parent')?.deliveryState ?? null, null)
  assert.equal(harness.repository.get('parent')?.packetRole ?? null, null)
  assert.equal(harness.repository.get('child-a'), null)
  assert.equal(harness.repository.get('child-b'), null)
  assert.deepEqual(events, [])
})

test('DynamicDeliveryTaskStore commits parent and children before one batched change event', (t) => {
  const harness = openHarness(t)
  if (!harness) return
  const parent = projection()
  harness.repository.create(parent)
  const events: TaskProjectionChangeEvent[] = []
  harness.repository.on('change', (event) => events.push(event))
  const store = new DynamicDeliveryTaskStore(harness.repository)
  const packages: WorkPackage[] = ['pkg-a', 'pkg-b'].map((packageId) => ({
    packageId, title: packageId, objective: 'objective', deliverable: 'deliverable', expectedOutputs: ['out'],
    proposedCriteria: [], contextRefIds: [`resource:${packageId}`],
    executorHint: { kind: 'registered_agent', agentId: 'analyst' }, criticality: 'required',
  }))

  const children = store.createPacketTree({
    parent, deliveryState: state(), packages,
    buildChild: ({ workPackage, childTaskId }) => projection({
      taskId: childTaskId, runId: `run-${workPackage.packageId}`, parentTaskId: 'parent',
      taskOrigin: 'workflow_child', ownerAgentId: 'butler', executionBinding: binding(`run-${workPackage.packageId}`),
      packetRole: 'child', contextRefs: workPackage.contextRefIds,
    }),
  })
  assert.equal(children.length, 2)
  assert.equal(harness.repository.listByParentTask('parent').length, 2)
  assert.equal(harness.repository.get('parent')?.packetRole, 'parent')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.reason, 'dynamic_delivery_tree')
  assert.deepEqual(new Set(events[0]?.changedTaskIds), new Set(['parent', ...children.map((child) => child.taskId)]))
})

test('CAS reductions preserve sibling settlements and reject stale revision or generation', (t) => {
  const harness = openHarness(t)
  if (!harness) return
  harness.repository.create(projection({ deliveryState: state(), packetRole: 'parent' }))
  const store = new DynamicDeliveryTaskStore(harness.repository)
  const first = store.reduceState({
    taskId: 'parent', parentGeneration: 4, expectedStateRevision: 0,
    reduce: (current) => ({
      ...current, stateRevision: 1,
      packages: current.packages.map((pkg) => pkg.packageId === 'pkg-a' ? { ...pkg, status: 'completed' } : pkg),
    }),
  })
  assert.equal(first.packages.find((pkg) => pkg.packageId === 'pkg-a')?.status, 'completed')
  const second = store.reduceState({
    taskId: 'parent', parentGeneration: 4, expectedStateRevision: 1,
    reduce: (current) => ({
      ...current, stateRevision: 2,
      packages: current.packages.map((pkg) => pkg.packageId === 'pkg-b' ? { ...pkg, status: 'degraded' } : pkg),
    }),
  })
  assert.equal(second.packages.find((pkg) => pkg.packageId === 'pkg-a')?.status, 'completed')
  assert.equal(second.packages.find((pkg) => pkg.packageId === 'pkg-b')?.status, 'degraded')
  assert.throws(() => store.reduceState({
    taskId: 'parent', parentGeneration: 4, expectedStateRevision: 1, reduce: (current) => ({ ...current, stateRevision: 2 }),
  }), /revision conflict/)
  assert.throws(() => store.reduceState({
    taskId: 'parent', parentGeneration: 3, expectedStateRevision: 2, reduce: (current) => ({ ...current, stateRevision: 3 }),
  }), /stale delivery parent generation/)
})

test('attempt identities are deterministic per generation/package/attempt and change on redispatch', () => {
  const base = { parentTaskId: 'parent', parentGeneration: 4, packageId: 'pkg-a', attempt: 0 as const }
  assert.deepEqual(deliveryAttemptIdentity(base), deliveryAttemptIdentity(base))
  assert.notDeepEqual(deliveryAttemptIdentity(base), deliveryAttemptIdentity({ ...base, attempt: 1 }))
  assert.notDeepEqual(deliveryAttemptIdentity(base), deliveryAttemptIdentity({ ...base, parentGeneration: 5 }))
})
