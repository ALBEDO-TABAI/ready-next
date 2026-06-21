import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SkillsRuntimeManager,
  type SkillRunResult,
} from '../main/modules/skills-runtime/runtime-manager'

interface ScheduleRow {
  id: string
  skill_id: string
  action: string
  params_json: string | null
  interval_minutes: number
  next_run_at: string
  last_run_at: string | null
  enabled: number
  created_at: string
  updated_at: string
}

class FakeScheduleDatabase {
  rows: ScheduleRow[] = []
  normalAdvanceCount = 0
  retryAdvanceCount = 0

  prepare(sql: string): { run: (...args: unknown[]) => unknown; all: <T>() => T[] } {
    return {
      run: (...args: unknown[]) => {
        if (/INSERT INTO skills_schedules/.test(sql)) {
          const [id, skillId, action, paramsJson, intervalMinutes, nextRunAt, createdAt, updatedAt] = args
          this.rows.push({
            id: String(id),
            skill_id: String(skillId),
            action: String(action),
            params_json: String(paramsJson),
            interval_minutes: Number(intervalMinutes),
            next_run_at: String(nextRunAt),
            last_run_at: null,
            enabled: 1,
            created_at: String(createdAt),
            updated_at: String(updatedAt),
          })
          return undefined
        }
        if (/SET last_run_at = \?, next_run_at = \?, updated_at = \?/.test(sql)) {
          this.normalAdvanceCount += 1
          const [lastRunAt, nextRunAt, updatedAt, id] = args
          const row = this.rows.find((item) => item.id === id)
          if (row) {
            row.last_run_at = String(lastRunAt)
            row.next_run_at = String(nextRunAt)
            row.updated_at = String(updatedAt)
          }
          return undefined
        }
        if (/SET next_run_at = \?, updated_at = \?/.test(sql)) {
          this.retryAdvanceCount += 1
          const [nextRunAt, updatedAt, id] = args
          const row = this.rows.find((item) => item.id === id)
          if (row) {
            row.next_run_at = String(nextRunAt)
            row.updated_at = String(updatedAt)
          }
        }
        return undefined
      },
      all: <T>() => {
        if (/WHERE id = \?/.test(sql)) return this.rows.slice(-1) as T[]
        return [...this.rows] as T[]
      },
    }
  }
}

function createManager(db: FakeScheduleDatabase): SkillsRuntimeManager {
  const manager = new SkillsRuntimeManager({
    runtimeRoot: mkdtempSync(join(tmpdir(), 'ready-schedule-test-')),
    startBackgroundTasks: false,
  }) as SkillsRuntimeManager & {
    getRawDatabase: () => FakeScheduleDatabase
    listSkills: () => unknown[]
  }
  manager.getRawDatabase = () => db
  manager.listSkills = () => [{
    id: 'demo-skill',
    name: 'Demo',
    description: '',
    version: '1.0.0',
    installed: true,
    installStatePath: '',
    source: 'embedded',
    manifestValid: true,
    actions: [{ name: 'valid_action' }],
    executionMode: 'direct',
  }]
  return manager
}

function failedRunResult(): SkillRunResult {
  return {
    success: false,
    skillId: 'demo-skill',
    action: 'valid_action',
    stdout: '',
    stderr: 'failed',
    command: [],
    error: 'planned failure',
  }
}

test('createSchedule rejects unknown actions before inserting a schedule row', () => {
  const db = new FakeScheduleDatabase()
  const manager = createManager(db)

  assert.throws(() => manager.createSchedule({
    skillId: 'demo-skill',
    action: 'missing_action',
    params: {},
    intervalMinutes: 5,
  }), /Unknown action: missing_action/)
  assert.equal(db.rows.length, 0)
})

test('runScheduledTask retries when runSkill returns success false', async () => {
  const db = new FakeScheduleDatabase()
  const manager = createManager(db) as SkillsRuntimeManager & {
    runScheduledTask: (schedule: ScheduleRow) => Promise<void>
    runSkill: () => Promise<SkillRunResult>
  }
  const schedule = manager.createSchedule({
    skillId: 'demo-skill',
    action: 'valid_action',
    params: {},
    intervalMinutes: 30,
    startAt: '2026-06-20T00:00:00.000Z',
  }) as unknown as ScheduleRow
  const row = db.rows.find((item) => item.id === schedule.id)
  assert.ok(row)

  manager.runSkill = async () => failedRunResult()
  await manager.runScheduledTask(row)

  assert.equal(db.normalAdvanceCount, 0)
  assert.equal(db.retryAdvanceCount, 1)
  assert.equal(row.last_run_at, null)
  assert.ok(new Date(row.next_run_at).getTime() > Date.now())
})
