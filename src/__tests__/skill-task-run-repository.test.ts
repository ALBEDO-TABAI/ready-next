import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SkillTaskRunRepository,
  createSkillTaskRunId,
  type SkillTaskRunRecord,
} from '../main/modules/repositories/skill-task-run-repository'

function createRepositoryHarness() {
  const rows = new Map<string, Record<string, unknown>>()
  const byUpdatedDesc = (items: Record<string, unknown>[]) =>
    items.sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))

  const repository = new SkillTaskRunRepository({
    getRawDb() {
      return {
        prepare(sql: string) {
          if (sql.includes('INSERT INTO skill_task_runs')) {
            return {
              run(...params: unknown[]) {
                rows.set(String(params[0]), {
                  id: params[0],
                  scope_id: params[1],
                  session_id: params[2],
                  agent: params[3],
                  run_id: params[4],
                  skill_id: params[5],
                  skill_name: params[6],
                  action: params[7],
                  tool_name: params[8],
                  run_kind: params[9],
                  status: params[10],
                  interaction_state: params[11],
                  goal_text: params[12],
                  resource_refs_json: params[13],
                  params_json: params[14],
                  steps_json: params[15],
                  current_step_id: params[16],
                  artifacts_json: params[17],
                  output_dir: params[18],
                  run_state_path: params[19],
                  scene_scores_path: params[20],
                  delivery_report_path: params[21],
                  failure_kind: params[22],
                  failure_detail: params[23],
                  job_id: params[24],
                  detached_task_id: params[25],
                  resume_payload_json: params[26],
                  created_at: params[27],
                  started_at: params[28],
                  updated_at: params[29],
                  finished_at: params[30],
                })
                return { changes: 1 }
              },
              get() {
                return undefined
              },
              all() {
                return []
              },
            }
          }

          if (sql.startsWith('UPDATE skill_task_runs SET')) {
            return {
              run(...params: unknown[]) {
                const id = String(params[params.length - 1])
                const current = rows.get(id)!
                const setClause = sql.slice('UPDATE skill_task_runs SET '.length, sql.indexOf(' WHERE id = ?'))
                const columns = setClause.split(', ').map((item) => item.replace(' = ?', ''))
                columns.forEach((column, index) => {
                  current[column] = params[index]
                })
                rows.set(id, current)
                return { changes: 1 }
              },
              get() {
                return undefined
              },
              all() {
                return []
              },
            }
          }

          if (sql.includes('WHERE id = ? LIMIT 1')) {
            return {
              run() {
                return { changes: 0 }
              },
              get(id: string) {
                return rows.get(id) as any
              },
              all() {
                return []
              },
            }
          }

          if (sql.includes('WHERE scope_id = ?')) {
            return {
              run() {
                return { changes: 0 }
              },
              get() {
                return undefined
              },
              all(scopeId: string, limit: number) {
                return byUpdatedDesc(Array.from(rows.values()).filter((row) => row.scope_id === scopeId))
                  .slice(0, limit) as any[]
              },
            }
          }

          if (sql.includes('WHERE session_id = ?') && sql.includes("status IN ('queued', 'running', 'blocked')")) {
            return {
              run() {
                return { changes: 0 }
              },
              get() {
                return undefined
              },
              all(sessionId: string, limit: number) {
                return byUpdatedDesc(Array.from(rows.values()).filter((row) =>
                  row.session_id === sessionId
                  && ['queued', 'running', 'blocked'].includes(String(row.status)),
                )).slice(0, limit) as any[]
              },
            }
          }

          if (sql.includes('WHERE detached_task_id = ?')) {
            return {
              run() {
                return { changes: 0 }
              },
              get(detachedTaskId: string) {
                return byUpdatedDesc(Array.from(rows.values()).filter((row) => row.detached_task_id === detachedTaskId))[0] as any
              },
              all() {
                return []
              },
            }
          }

          return {
            run() {
              return { changes: 0 }
            },
            get(...params: unknown[]) {
              const [first] = params
              let candidates = Array.from(rows.values())
              if (sql.includes('session_id = ?')) {
                candidates = candidates.filter((row) => row.session_id === first)
              }
              if (sql.includes("'running', 'blocked', 'failed', 'done'")) {
                candidates = candidates.filter((row) =>
                  ['running', 'blocked', 'failed', 'done'].includes(String(row.status)),
                )
              } else if (sql.includes("'running', 'blocked', 'failed'")) {
                candidates = candidates.filter((row) =>
                  ['running', 'blocked', 'failed'].includes(String(row.status)),
                )
              }
              return byUpdatedDesc(candidates)[0] as any
            },
            all() {
              return []
            },
          }
        },
      } as any
    },
  } as any)

  return { repository, rows }
}

function makeRun(overrides: Partial<SkillTaskRunRecord> = {}): SkillTaskRunRecord {
  return {
    id: overrides.id || 'str-test001',
    scopeId: overrides.scopeId ?? 'scope-1',
    sessionId: overrides.sessionId ?? 'session-1',
    agent: overrides.agent ?? 'butler',
    runId: overrides.runId ?? 'run-1',
    skillId: overrides.skillId || 'video-expert-analyzer',
    skillName: overrides.skillName ?? 'Video Expert Analyzer (VNext)',
    action: overrides.action || 'video_expert_pipeline',
    toolName: overrides.toolName ?? 'skill_video_expert_pipeline',
    runKind: overrides.runKind || 'typed_action',
    status: overrides.status || 'running',
    interactionState: overrides.interactionState || 'running',
    goalText: overrides.goalText ?? '分析视频',
    resourceRefs: overrides.resourceRefs || [{ type: 'video', url: 'https://example.com/video' }],
    params: overrides.params || { url: 'https://example.com/video' },
    steps: overrides.steps || [{
      id: 'skill_video_expert_pipeline#1',
      title: '执行视频分析',
      status: 'running',
      detail: null,
      updatedAt: '2026-04-27T08:00:00.000Z',
    }],
    currentStepId: overrides.currentStepId ?? 'skill_video_expert_pipeline#1',
    artifacts: overrides.artifacts || [],
    outputDir: overrides.outputDir ?? '/tmp/vea-output',
    runStatePath: overrides.runStatePath ?? '/tmp/vea-output/run_state.json',
    sceneScoresPath: overrides.sceneScoresPath ?? '/tmp/vea-output/scene_scores.json',
    deliveryReportPath: overrides.deliveryReportPath ?? '/tmp/vea-output/delivery_report.json',
    failureKind: overrides.failureKind ?? null,
    failureDetail: overrides.failureDetail ?? null,
    jobId: overrides.jobId ?? 'job-1',
    detachedTaskId: overrides.detachedTaskId ?? null,
    resumePayload: overrides.resumePayload || { todoId: 'skill_video_expert_pipeline#1' },
    createdAt: overrides.createdAt || '2026-04-27T08:00:00.000Z',
    startedAt: overrides.startedAt ?? '2026-04-27T08:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-04-27T08:00:00.000Z',
    finishedAt: overrides.finishedAt ?? null,
  }
}

test('SkillTaskRunRepository persists and updates recoverable skill task runs', () => {
  const { repository } = createRepositoryHarness()
  repository.create(makeRun())

  repository.update('str-test001', {
    status: 'failed',
    interactionState: 'running',
    failureKind: 'auth_invalid',
    failureDetail: 'Invalid API Key',
    steps: [{
      id: 'skill_video_expert_pipeline#1',
      title: '执行视频分析',
      status: 'error',
      detail: 'Invalid API Key',
      updatedAt: '2026-04-27T08:04:00.000Z',
    }],
    updatedAt: '2026-04-27T08:04:00.000Z',
    finishedAt: '2026-04-27T08:04:00.000Z',
  })

  const stored = repository.get('str-test001')
  const listed = repository.listByScope('scope-1')
  const recoverable = repository.findLatestRecoverable({ sessionId: 'session-1' })

  assert.ok(stored)
  assert.equal(stored?.status, 'failed')
  assert.equal(stored?.failureKind, 'auth_invalid')
  assert.equal(stored?.failureDetail, 'Invalid API Key')
  assert.equal(stored?.steps[0]?.status, 'error')
  assert.equal(stored?.resourceRefs?.[0] && (stored.resourceRefs[0] as any).type, 'video')
  assert.equal(stored?.params?.url, 'https://example.com/video')
  assert.equal(stored?.resumePayload?.todoId, 'skill_video_expert_pipeline#1')
  assert.equal(listed.length, 1)
  assert.equal(recoverable?.id, 'str-test001')
})

test('SkillTaskRunRepository active lookup excludes terminal tasks', () => {
  const { repository } = createRepositoryHarness()
  repository.create(makeRun({
    id: 'str-active',
    status: 'blocked',
    updatedAt: '2026-04-27T08:03:00.000Z',
  }))
  repository.create(makeRun({
    id: 'str-done',
    status: 'done',
    updatedAt: '2026-04-27T08:04:00.000Z',
    finishedAt: '2026-04-27T08:04:00.000Z',
  }))
  repository.create(makeRun({
    id: 'str-cancelled',
    status: 'cancelled',
    updatedAt: '2026-04-27T08:05:00.000Z',
    finishedAt: '2026-04-27T08:05:00.000Z',
  }))

  const active = repository.listActiveBySession('session-1')
  const recoverable = repository.findLatestRecoverable({ sessionId: 'session-1' })
  const recoverableIncludingDone = repository.findLatestRecoverable({ sessionId: 'session-1', includeDone: true })

  assert.deepEqual(active.map((item) => item.id), ['str-active'])
  assert.equal(recoverable?.id, 'str-active')
  assert.equal(recoverableIncludingDone?.id, 'str-done')
})

test('SkillTaskRunRepository finds detached task archive rows', () => {
  const { repository } = createRepositoryHarness()
  repository.create(makeRun({
    id: 'str-detached',
    runKind: 'detached',
    detachedTaskId: 'dst-123',
    status: 'running',
  }))

  const byDetached = repository.findByDetachedTaskId('dst-123')
  assert.equal(byDetached?.id, 'str-detached')
})

test('createSkillTaskRunId uses the lightweight skill task prefix', () => {
  assert.match(createSkillTaskRunId(), /^str-[a-f0-9]{8}$/)
})
