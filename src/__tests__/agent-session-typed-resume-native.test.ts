import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { MemorySession, type AgentInputItem } from '@openai/agents'

import type { DatabaseConnection } from '../main/modules/database'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { AgentSessionCheckpointRepository, workflowDigest } from '../main/modules/repositories/agent-session-checkpoint-repository'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { AgentSessionInputController } from '../main/modules/agent-control/runtime-core/agent-session-input-controller'
import { buildBrowserVerifierRecoveryItem } from '../main/modules/agent-control/runtime-core/agent-sdk-browser-suspension'
import type { ToolBridgeRuntimeContext } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import { buildPreparedSkillTurnTruth } from '../main/modules/agent-control/skills/prepared-skill-turn'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { BrowserTargetClaimRepository, BrowserTargetClaimService } from '../main/modules/browser-engine/browser-target-claims'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type SqliteCtor = new (path: string) => DatabaseConnection & MigrationDatabase
type ResumeReason = 'budget' | 'incomplete' | 'steering' | 'provider_transfer'
const require = createRequire(import.meta.url)

function openDb(): DatabaseConnection & MigrationDatabase {
  const mod = require('better-sqlite3') as SqliteCtor & { default?: SqliteCtor }
  const Sqlite = mod.default || mod
  const db = new Sqlite(':memory:')
  runMigrations(db)
  return db
}

function executionBinding(runId: string) {
  return {
    schemaVersion: 1 as const,
    runId,
    ownerAgentIdAtStart: 'butler',
    runOrigin: 'initial' as const,
    kind: 'registered_agent' as const,
    requestedAgentId: 'butler',
    effectiveAgentId: 'butler',
    executionMaterialHash: 'butler-material-hash',
    ownerAssignmentSource: 'conversation_active' as const,
    executionSelectionSource: 'task_owner' as const,
    resolutionKind: 'direct' as const,
  }
}

function preparedSkill() {
  const authorization = buildExplicitNoSkillAuthorization('no_skill_signal')
  return buildPreparedSkillTurnTruth({
    identity: { mode: 'none', reason: 'no_skill_signal' },
    authorization,
    requestOrResourceAnchorDigest: 'request-anchor-digest',
    floors: { toolNames: new Set(), reasons: [] },
    surface: { composition: 'additive', exclusiveScopeRef: null },
  })
}

test('typed Browser resumes consume suspension once and preserve compacted recovery deltas', async (t) => {
  if (skipIfSqliteUnavailable(t, 'typed-browser-resume-native')) return
  for (const [index, reason] of (['budget', 'incomplete', 'steering', 'provider_transfer'] as const).entries()) {
    await t.test(reason, async () => {
      const db = openDb()
      try {
        const accessor = { getRawDb: () => db }
        const projections = new TaskProjectionRepository(accessor)
        const runMeta = new RunMetaRepository(db)
        const repository = new AgentSessionCheckpointRepository(accessor)
        const taskId = `typed-resume-${reason}`
        const scopeId = `scope-${taskId}`
        const oldRunId = `run-${taskId}-old`
        const oldBinding = executionBinding(oldRunId)
        const now = new Date(Date.UTC(2026, 6, 22, 3, index, 0)).toISOString()
        projections.create({
          taskId,
          scopeId,
          runId: oldRunId,
          taskType: 'research',
          module: 'browser',
          status: 'running',
          interactionState: 'running',
          waitingFor: 'none',
          steps: [],
          ownerAgentId: 'butler',
          taskOrigin: 'user_root',
          executionBinding: oldBinding,
          createdAt: now,
          updatedAt: now,
        })
        runMeta.create({
          runId: oldRunId,
          taskId,
          scopeId,
          agentId: 'butler',
          executionBinding: oldBinding,
          status: 'running',
        }, Date.parse(now))
        db.prepare(
          `INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
           VALUES (?, 'butler', ?, ?, ?)`,
        ).run(scopeId, `Typed resume ${reason}`, now, now)
        const sourceMessageId = `message-${taskId}`
        db.prepare(
          `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
           VALUES (?, ?, 'user', 'continue browser work', ?, '{}')`,
        ).run(sourceMessageId, scopeId, now)
        const route = await repository.bindBrowserWorkflowRoute({
          parentTaskId: taskId,
          ownerRunId: oldRunId,
          sourceMessageId,
          executionBinding: oldBinding,
          now,
        })
        const base = [{ role: 'user', content: `base-${reason}` } as AgentInputItem]
        await repository.writeCleanBoundary({
          parentTaskId: taskId,
          browserTaskId: route.browserTaskId,
          ownerRunId: oldRunId,
          sourceItems: base,
          sdkSourceItems: base,
          sdkSourceItemCount: base.length,
          sdkSourcePrefixDigest: workflowDigest(base),
          preparedSkill: preparedSkill(),
          activatedCapabilityGroups: ['browser'],
          now,
        })
        if (reason === 'steering') {
          await repository.persistCanonicalMessageAndSteer({
            parentTaskId: taskId,
            ownerRunId: oldRunId,
            message: {
              id: `steering-${taskId}`,
              conversationId: scopeId,
              content: `recovery-${reason}`,
              structuredContent: `recovery-${reason}`,
              timestamp: new Date(Date.parse(now) + 1).toISOString(),
            },
          })
        }
        const recovery = reason === 'incomplete'
          ? buildBrowserVerifierRecoveryItem({
              rejectedCandidateDigest: workflowDigest(reason),
              verdict: 'repair',
              summary: `recovery-${reason}`,
              gaps: [{ kind: 'text', description: `recovery-${reason}` }],
            })
          : { role: 'system', content: `recovery-${reason}` } as AgentInputItem
        const recoveryItems = reason === 'provider_transfer'
          ? [recovery, structuredClone(recovery) as AgentInputItem]
          : [recovery]
        const suspensionInput = [...base, ...recoveryItems]
        const suspension = await repository.writeCleanBoundary({
          parentTaskId: taskId,
          browserTaskId: route.browserTaskId,
          ownerRunId: oldRunId,
          role: 'suspension',
          suspensionReason: reason,
          publicNotice: `checkpoint-${reason}`,
          sourceItems: suspensionInput,
          sdkSourceItems: suspensionInput,
          sdkSourceItemCount: suspensionInput.length,
          sdkSourcePrefixDigest: workflowDigest(suspensionInput),
          preparedSkill: preparedSkill(),
          activatedCapabilityGroups: ['browser'],
          now: new Date(Date.parse(now) + 2).toISOString(),
        })
        const projection = projections.get(taskId)
        assert.ok(projection)
        const wakeKind = reason === 'steering' ? 'steering'
          : reason === 'provider_transfer' ? 'provider_transfer'
            : 'user_continue'
        const sourceId = reason === 'steering'
          ? suspension.steeringReceiptIds.at(-1) || ''
          : `source-${reason}`
        const sourceDigest = reason === 'steering'
          ? suspension.steeringReceiptDigests.at(-1) || ''
          : workflowDigest({
              parentTaskId: taskId,
              checkpointId: suspension.checkpointId,
              basisRevision: projection?.revision,
              kind: wakeKind,
              sourceId,
            })
        const newRunId = `run-${taskId}-new`
        const resumed = await repository.resumeSuspendedBrowserWorkflow({
          taskId,
          newOwnerRunId: newRunId,
          executionBinding: executionBinding(newRunId),
          wake: {
            wakeId: `wake-${reason}`,
            checkpointId: suspension.checkpointId,
            basisRevision: projection?.revision || 0,
            kind: wakeKind,
            sourceId,
            sourceDigest,
            issuedAt: new Date(Date.parse(now) + 3).toISOString(),
          },
        })
        assert.equal(repository.current(taskId, 'suspension'), null)
        assert.equal(repository.current(taskId, 'clean_base')?.checkpointId, resumed.checkpoint.checkpointId)
        if (reason === 'provider_transfer') {
          assert.equal(
            JSON.stringify(resumed.checkpoint.finalInput).match(/recovery-provider_transfer/g)?.length,
            2,
          )
        }

        const runtimeContext = {
          taskId,
          runId: newRunId,
          activatedCapabilityGroups: ['browser'],
          browserWorkflowRoute: {
            browserTaskId: route.browserTaskId,
            requestAnchorSnapshotDigest: route.requestAnchorSnapshotDigest,
          },
          browserObservationGaps: [],
          browserSuspensionRequest: null,
          preparedSkillTurn: preparedSkill(),
          lastEffectiveBrowserActionSeq: 0,
          browserRequiredOperationIds: [],
        } as unknown as ToolBridgeRuntimeContext
        const controller = new AgentSessionInputController(repository, runtimeContext, null)
        const session = new MemorySession({ initialItems: resumed.checkpoint.finalInput })
        const metrics: AgentMetricEvent[] = []
        __setMetricSinkForTests((event) => { metrics.push(event) })
        try {
          await controller.prepareRunnerSession(session)
          const filtered = await controller.filter(
            [{ role: 'system', content: `compacted-${reason}` } as AgentInputItem],
            { sourceItems: resumed.checkpoint.finalInput, compacted: true },
          )
          assert.match(JSON.stringify(filtered), new RegExp(`recovery-${reason}`))
          assert.doesNotMatch(JSON.stringify(filtered), /readyTypedResumeRecovery/)
          assert.deepEqual(await session.getItems(), resumed.checkpoint.finalInput)
          const secondBoundary = await controller.filter(filtered, {
            sourceItems: filtered,
            compacted: false,
          })
          assert.doesNotMatch(JSON.stringify(secondBoundary), /readyTypedResumeRecovery/)
          if (reason === 'provider_transfer') {
            assert.equal(JSON.stringify(filtered).match(/recovery-provider_transfer/g)?.length, 2)
            assert.equal(JSON.stringify(secondBoundary).match(/recovery-provider_transfer/g)?.length, 2)
          }
        } finally {
          __setMetricSinkForTests(null)
        }
        assert.equal(metrics.some((event) => event.metric === 'owner_local_runner_session_rebased'), false)
        assert.equal(metrics.some((event) => event.metric === 'owner_local_session_source_cursor_mismatch'), false)
      } finally {
        db.close()
      }
    })
  }
})

test('physical pointer and chrome navigation signals commit one target-level takeover transaction', async (t) => {
  if (skipIfSqliteUnavailable(t, 'target-takeover-signal-native')) return
  for (const [index, signal] of (['pointer', 'navigation'] as const).entries()) {
    await t.test(signal, async () => {
      const db = openDb()
      try {
        const accessor = { getRawDb: () => db }
        const projections = new TaskProjectionRepository(accessor)
        const runMeta = new RunMetaRepository(db)
        const repository = new AgentSessionCheckpointRepository(accessor)
        const claims = new BrowserTargetClaimService(new BrowserTargetClaimRepository(accessor))
        const taskId = `takeover-${signal}`
        const scopeId = `scope-${taskId}`
        const runId = `run-${taskId}`
        const binding = executionBinding(runId)
        const now = new Date(Date.UTC(2026, 6, 22, 4, index, 0)).toISOString()
        projections.create({
          taskId, scopeId, runId, taskType: 'research', module: 'browser',
          status: 'running', interactionState: 'running', waitingFor: 'none', steps: [],
          ownerAgentId: 'butler', taskOrigin: 'user_root', executionBinding: binding,
          createdAt: now, updatedAt: now,
        })
        runMeta.create({
          runId, taskId, scopeId, agentId: 'butler', executionBinding: binding, status: 'running',
        }, Date.parse(now))
        db.prepare(
          `INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
           VALUES (?, 'butler', ?, ?, ?)`,
        ).run(scopeId, `Takeover ${signal}`, now, now)
        const sourceMessageId = `message-${taskId}`
        db.prepare(
          `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
           VALUES (?, ?, 'user', 'drive browser', ?, '{}')`,
        ).run(sourceMessageId, scopeId, now)
        const route = await repository.bindBrowserWorkflowRoute({
          parentTaskId: taskId, ownerRunId: runId, sourceMessageId, executionBinding: binding, now,
        })
        const base = [{ role: 'user', content: 'drive browser' } as AgentInputItem]
        await repository.writeCleanBoundary({
          parentTaskId: taskId, browserTaskId: route.browserTaskId, ownerRunId: runId,
          sourceItems: base, sdkSourceItems: base, sdkSourceItemCount: 1,
          sdkSourcePrefixDigest: workflowDigest(base), preparedSkill: preparedSkill(),
          activatedCapabilityGroups: ['browser'], now,
        })
        const target = claims.acquire({
          partition: 'persist:browser', tabId: 'tab-a',
          physicalTargetToken: `boot-live:tab-a:${index}`, bootIncarnationId: 'boot-live',
          profileId: null, surface: 'user-view', parentTaskId: taskId,
          browserTaskId: route.browserTaskId, ownerRunId: runId, scopeId, sessionId: null,
        })
        const sibling = claims.acquire({
          partition: 'persist:browser', tabId: 'tab-b',
          physicalTargetToken: `boot-live:tab-b:${index}`, bootIncarnationId: 'boot-live',
          profileId: null, surface: 'user-view', parentTaskId: taskId,
          browserTaskId: route.browserTaskId, ownerRunId: runId, scopeId, sessionId: null,
        })
        if (isAgentBrowserError(target) || isAgentBrowserError(sibling)) throw new Error('claim setup failed')
        await repository.createHumanTakeoverIntent({
          parentTaskId: taskId,
          ownerRunId: runId,
          browserTaskId: route.browserTaskId,
          targetClaimId: target.claimId,
          targetClaimGeneration: target.generation,
          physicalTarget: {
            surface: 'user-view', scopeId, profileId: null, sessionId: null,
            tabId: target.logicalKey.tabId,
            physicalTargetToken: target.physicalTargetToken || '',
            source: 'physical_input',
          },
          now,
        })
        assert.equal(claims.read(target.logicalKey)?.state, 'user_owned')
        assert.equal(claims.read(sibling.logicalKey)?.state, 'held')
        assert.equal(
          db.prepare(`SELECT COUNT(*) AS count FROM browser_control_receipts
                       WHERE browser_task_id = ? AND kind = 'target_user_owned'`)
            .get<{ count: number }>(route.browserTaskId)?.count,
          1,
        )
      } finally {
        db.close()
      }
    })
  }
})
