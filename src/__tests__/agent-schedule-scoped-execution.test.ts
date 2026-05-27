import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { executeAgentSchedule } from '../main/modules/agent-control/runtime-core/schedule-execution'

function scheduleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'schedule-scope-1',
    name: 'Scoped schedule',
    cron_expr: '* * * * *',
    prompt: 'write the daily note',
    payload_json: JSON.stringify({
      scopeId: 'conv-scope-1',
      agent: 'butler',
      workspaceRoot: '/tmp/ready-workspace',
    }),
    ...overrides,
  }
}

function createRuntimeHarness(params: {
  sendScoped?: (payload: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>
  send?: (...args: unknown[]) => Promise<{ success: boolean; error?: string }>
} = {}): Record<string, unknown> & {
  markedRuns: string[]
  scopedPayloads: Record<string, unknown>[]
  unscopedSends: unknown[][]
} {
  const markedRuns: string[] = []
  const scopedPayloads: Record<string, unknown>[] = []
  const unscopedSends: unknown[][] = []
  return {
    markedRuns,
    scopedPayloads,
    unscopedSends,
    tryParseJson: (value: string, fallback: Record<string, unknown>) => {
      try {
        const parsed = JSON.parse(value) as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : fallback
      } catch {
        return fallback
      }
    },
    db: {
      markAgentScheduleRun: (id: string) => {
        markedRuns.push(id)
      },
    },
    sendScoped: async (payload: Record<string, unknown>) => {
      scopedPayloads.push(payload)
      return params.sendScoped ? params.sendScoped(payload) : { success: true }
    },
    orchestrator: {
      send: async (...args: unknown[]) => {
        unscopedSends.push(args)
        return params.send ? params.send(...args) : { success: true }
      },
    },
  }
}

test('executeSchedule routes schedules with a stored scope through sendScoped', async () => {
  const runtime = createRuntimeHarness()

  const result = await executeAgentSchedule(scheduleRow(), {
    parseJson: runtime.tryParseJson as (value: string, fallback: Record<string, unknown>) => Record<string, unknown>,
    sendScoped: runtime.sendScoped as never,
    sendUnscoped: (runtime.orchestrator as { send: never }).send,
    markRun: (id) => runtime.markedRuns.push(id),
    now: () => new Date('2026-05-26T12:00:00.000Z'),
    createId: () => 'uuid-1',
  }, 'manual')

  assert.equal(result.success, true)
  assert.equal(runtime.scopedPayloads.length, 1)
  assert.equal(runtime.unscopedSends.length, 0)
  assert.deepEqual(runtime.markedRuns, ['schedule-scope-1'])

  const payload = runtime.scopedPayloads[0]
  assert.equal(payload.scopeId, 'conv-scope-1')
  assert.equal(payload.agent, 'butler')
  assert.match(String(payload.message), /^\[cron:Scoped schedule\] write the daily note$/)
  assert.equal(payload.requestId, 'schedule-schedule-scope-1-uuid-1')

  const userMessage = payload.userMessage as Record<string, unknown>
  assert.equal(userMessage.content, '[cron:Scoped schedule] write the daily note')
  const meta = userMessage.meta as Record<string, unknown>
  assert.equal(meta.source, 'agent_schedule')
  assert.equal(meta.scheduleId, 'schedule-scope-1')
  assert.equal(meta.scheduleName, 'Scoped schedule')
  assert.equal(meta.cronExpr, '* * * * *')
  assert.equal(meta.triggerSource, 'manual')
  assert.equal(meta.workspaceId, '/tmp/ready-workspace')
})

test('executeSchedule does not mark a scoped schedule run when sendScoped fails', async () => {
  const runtime = createRuntimeHarness({
    sendScoped: async () => ({ success: false, error: 'scope unavailable' }),
  })

  const result = await executeAgentSchedule(scheduleRow(), {
    parseJson: runtime.tryParseJson as (value: string, fallback: Record<string, unknown>) => Record<string, unknown>,
    sendScoped: runtime.sendScoped as never,
    sendUnscoped: (runtime.orchestrator as { send: never }).send,
    markRun: (id) => runtime.markedRuns.push(id),
    createId: () => 'uuid-2',
  }, 'cron')

  assert.equal(result.success, false)
  assert.equal(result.error, 'scope unavailable')
  assert.deepEqual(runtime.markedRuns, [])
  assert.equal(runtime.scopedPayloads.length, 1)
})

test('executeSchedule falls back to the legacy direct send only when no scope is stored', async () => {
  const runtime = createRuntimeHarness()

  const result = await executeAgentSchedule(scheduleRow({
    payload_json: JSON.stringify({ agent: 'researcher' }),
  }), {
    parseJson: runtime.tryParseJson as (value: string, fallback: Record<string, unknown>) => Record<string, unknown>,
    sendScoped: runtime.sendScoped as never,
    sendUnscoped: (runtime.orchestrator as { send: never }).send,
    markRun: (id) => runtime.markedRuns.push(id),
    createId: () => 'uuid-3',
  }, 'cron')

  assert.equal(result.success, true)
  assert.equal(runtime.scopedPayloads.length, 0)
  assert.equal(runtime.unscopedSends.length, 1)
  assert.equal(runtime.unscopedSends[0][0], 'researcher')
  assert.equal(runtime.unscopedSends[0][1], '[cron:Scoped schedule] write the daily note')
  assert.equal(runtime.unscopedSends[0][2], 'schedule-schedule-scope-1-uuid-3')
  assert.deepEqual(runtime.markedRuns, ['schedule-scope-1'])
})

test('runScheduleNow does not call sidecar.runScheduleNow and queue a duplicate trigger', async () => {
  const source = await readFile(
    resolve('src/main/modules/agent-control/runtime-core/runtime.ts'),
    'utf8',
  )
  const start = source.indexOf('async runScheduleNow(')
  const end = source.indexOf('async syncDatabaseToSidecar', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const methodBody = source.slice(start, end)
  assert.doesNotMatch(methodBody, /sidecar\.runScheduleNow/)
  assert.match(methodBody, /executeSchedule\(schedule,\s*'manual'\)/)
})
