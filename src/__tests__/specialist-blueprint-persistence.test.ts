import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SpecialistBlueprintConfirmationStore } from '../main/modules/agent-control/agents/specialist-blueprint-confirmation'
import { SpecialistBlueprintStore } from '../main/modules/agent-control/agents/specialist-blueprint-store'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import type { DatabaseConnection } from '../main/modules/database'
import type { SpecialistAgentBlueprint, SpecialistBlueprintStatus } from '../shared/agent-specialist-blueprint'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type SqliteDb = DatabaseConnection & MigrationDatabase

async function openDb(file: string): Promise<SqliteDb> {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(file) as unknown as SqliteDb
  runMigrations(db)
  return db
}

function blueprint(
  blueprintId: string,
  status: SpecialistBlueprintStatus,
  overrides: Partial<SpecialistAgentBlueprint> = {},
): SpecialistAgentBlueprint {
  const slug = blueprintId.replace(/^bp-/, '')
  return {
    blueprintId,
    status,
    inferredScope: { slug, displayName: `${slug} 专项`, domain: slug, routingTriggers: [slug] },
    foundationDocs: { status: 'staged', charter: `${slug} charter`, rulesText: `${slug} rules`, knowledgeSeeds: [], toolSafetyNotes: 'none', foundationText: `# ${slug} Foundation` },
    provenance: { userRequestVerbatim: `我要一个 ${slug} 类型专项 agent`, sourceSessionId: 'session-1', sourceRunId: null, sourceMessageId: null, createdAt: '2026-06-20T00:00:00.000Z' },
    confirmation: { tokenId: null, confirmedAt: null, usedAt: null },
    rolePersona: `${slug} 专项以稳定角色处理重复任务、边界判断和证据整理。`,
    taskExamples: { suitable: [`${slug} 重复任务整理`], unsuitable: [`${slug} 之外的外发执行`] },
    mainVsSpecialistSplit: `主 agent 负责理解目标和最终决策，${slug} 专项负责重复性整理。`,
    toolBoundaries: {
      browser: { mode: 'confirm', notes: `${slug} 浏览前需要确认来源范围。` },
      write: { mode: 'confirm', notes: `${slug} 写入文件前必须确认路径和内容。` },
      externalSend: { mode: 'deny', notes: `${slug} 不代表用户外发消息或文件。` },
      longMemory: { mode: 'confirm', notes: `${slug} 长期记忆只记录用户确认过的稳定偏好。` },
    },
    memoryProfilePolicy: `${slug} 只使用当前任务和确认过的长期偏好，不保存临时猜测。`,
    lifecycleNotes: `${slug} 在触发词失效、职责重叠或长期不用时，经确认后更新或退休。`,
    specialistId: slug,
    displayName: `${slug} 专项`,
    charter: `${slug} charter`,
    intendedDomain: slug,
    nonGoals: ['不外发'],
    recurringTasks: ['整理'],
    requiredInputs: ['目标'],
    expectedOutputs: ['结论'],
    routingTriggers: [slug],
    routingActivateOnCreate: false,
    seedRulesText: `${slug} rules`,
    knowledgeSeeds: [],
    migrationCandidates: [],
    toolSafetyNotes: 'none',
    source: 'conversation',
    userRequestVerbatim: `我要一个 ${slug} 类型专项 agent`,
    clarificationAnswers: [],
    admissionVerdict: { kind: 'admit' },
    qualityChecks: [],
    ...overrides,
  }
}

test('specialist blueprint store persists drafts, clarification state, and confirmation tokens across DB restart', async (t) => {
  if (skipIfSqliteUnavailable(t, 'specialist blueprint persistence restart proof')) return
  const root = mkdtempSync(join(tmpdir(), 'ready-specialist-blueprint-persist-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dbPath = join(root, 'ready.db')

  const dbA = await openDb(dbPath)
  const storeA = new SpecialistBlueprintStore({ getRawDb: () => dbA })
  const confirmationsA = new SpecialistBlueprintConfirmationStore({ getRawDb: () => dbA })

  storeA.upsert(blueprint('bp-draft', 'draft'))
  storeA.upsert(blueprint('bp-clarify', 'needs_clarification', {
    clarificationAnswers: [{
      id: 'clarify-domain',
      question: '主要工作范围是什么？',
      answer: '只负责视觉参考研究。',
    }],
    admissionVerdict: { kind: 'clarify', missing: ['expected_outputs'] },
  }))
  storeA.upsert(blueprint('bp-staged', 'staged'))
  storeA.upsert(blueprint('bp-confirmed', 'confirmed', {
    confirmation: {
      tokenId: 'tok-used',
      confirmedAt: '2026-06-20T00:01:00.000Z',
      usedAt: '2026-06-20T00:02:00.000Z',
    },
  }))
  const token = confirmationsA.issue({
    blueprintId: 'bp-staged',
    sessionId: 'session-1',
    runId: 'run-1',
    blueprintHash: 'hash-staged',
    now: new Date('2026-06-20T00:03:00.000Z'),
  })
  dbA.close()

  const dbB = await openDb(dbPath)
  try {
    const storeB = new SpecialistBlueprintStore({ getRawDb: () => dbB })
    const confirmationsB = new SpecialistBlueprintConfirmationStore({ getRawDb: () => dbB })

    assert.deepEqual(
      storeB.list(['draft', 'needs_clarification', 'staged', 'confirmed']).map((item) => item.blueprintId),
      ['bp-clarify', 'bp-confirmed', 'bp-draft', 'bp-staged'],
    )
    const clarify = storeB.get('bp-clarify')
    assert.equal(clarify?.clarificationAnswers[0]?.answer, '只负责视觉参考研究。')
    assert.deepEqual(clarify?.admissionVerdict, { kind: 'clarify', missing: ['expected_outputs'] })

    const validated = confirmationsB.validate({
      tokenId: token.id,
      blueprintId: 'bp-staged',
      sessionId: 'session-1',
      runId: 'run-1',
      blueprintHash: 'hash-staged',
    })
    assert.equal(validated.usedAt, null)

    const used = confirmationsB.consume({
      tokenId: token.id,
      blueprintId: 'bp-staged',
      sessionId: 'session-1',
      runId: 'run-1',
      blueprintHash: 'hash-staged',
      now: new Date('2026-06-20T00:04:00.000Z'),
    })
    assert.equal(used.usedAt, '2026-06-20T00:04:00.000Z')
    assert.throws(() => confirmationsB.consume({
      tokenId: token.id,
      blueprintId: 'bp-staged',
      sessionId: 'session-1',
      runId: 'run-1',
      blueprintHash: 'hash-staged',
    }), /already used/)
  } finally {
    dbB.close()
  }
})

test('specialist blueprint DB mode does not silently fall back to memory when DB is unavailable', (t) => {
  if (skipIfSqliteUnavailable(t, 'specialist blueprint persistence DB-unavailable semantics')) return
  const store = new SpecialistBlueprintStore({ getRawDb: () => null })
  assert.deepEqual(store.list(['staged']), [])
  assert.equal(store.get('bp-missing'), null)
  assert.throws(() => store.upsert(blueprint('bp-unsafe', 'staged')), /database not available/)
  assert.throws(() => store.patch('bp-unsafe', { status: 'confirmed' }), /database not available/)

  const confirmations = new SpecialistBlueprintConfirmationStore({ getRawDb: () => null })
  assert.throws(() => confirmations.issue({
    blueprintId: 'bp-unsafe',
    sessionId: 'session-1',
    blueprintHash: 'hash-unsafe',
  }), /database not available/)
  assert.throws(() => confirmations.validate({
    tokenId: 'tok-missing',
    blueprintId: 'bp-unsafe',
    sessionId: 'session-1',
    blueprintHash: 'hash-unsafe',
  }), /token not found/)
  assert.throws(() => confirmations.consume({
    tokenId: 'tok-missing',
    blueprintId: 'bp-unsafe',
    sessionId: 'session-1',
    blueprintHash: 'hash-unsafe',
  }), /database not available/)
})
