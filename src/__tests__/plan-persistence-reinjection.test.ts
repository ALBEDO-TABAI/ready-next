import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import {
  buildActivePlanReminderText,
  clearActivePlanForScope,
  configureActivePlanPersistence,
  deriveCollectionPlanFromToolCall,
  noteToolResultForActivePlan,
  resetActivePlansForTests
} from '../main/modules/agent-control/system-reminders/active-plan-step-reminder'

test('active plan restores from durable scope metadata after in-memory state is lost', (t) => {
  const durable = new Map<string, ReturnType<typeof deriveCollectionPlanFromToolCall>>()
  configureActivePlanPersistence({
    load: (scope) => durable.get(scope) || null,
    save: (scope, plan) => durable.set(scope, structuredClone(plan)),
    remove: (scope) => { durable.delete(scope) },
  })
  t.after(() => {
    resetActivePlansForTests()
    configureActivePlanPersistence(null)
  })
  resetActivePlansForTests()

  noteToolResultForActivePlan(
    'scope-durable',
    'browser_visible_collect',
    { url: 'https://example.com/u/1' },
    1000,
    JSON.stringify({ taskId: 'discover-durable', status: 'completed', result: { targets: [{ id: 'n1' }] } })
  )
  resetActivePlansForTests()

  const restored = buildActivePlanReminderText('scope-durable', 1500)
  assert.ok(restored?.includes('当前步骤 2/3'), `expected durable plan restore, got: ${restored}`)
})

test('active plan persistence failures never interrupt the tool or reminder path', (t) => {
  configureActivePlanPersistence({
    load: () => { throw new Error('load unavailable') },
    save: () => { throw new Error('save unavailable') },
    remove: () => { throw new Error('remove unavailable') },
  })
  t.after(() => {
    resetActivePlansForTests()
    configureActivePlanPersistence(null)
  })
  resetActivePlansForTests()

  assert.doesNotThrow(() => buildActivePlanReminderText('scope-load-failure', 1000))
  assert.doesNotThrow(() => noteToolResultForActivePlan(
    'scope-save-failure',
    'browser_visible_collect',
    { url: 'https://example.com/u/1' },
    1000,
    JSON.stringify({ taskId: 'discover-save-failure', status: 'queued' })
  ))
  assert.match(buildActivePlanReminderText('scope-save-failure', 1100) || '', /当前步骤 1\/3/)
  assert.doesNotThrow(() => clearActivePlanForScope('scope-save-failure'))
})

test('expired persisted plans are removed and cannot be revived by later evidence', (t) => {
  const expired = deriveCollectionPlanFromToolCall(
    'browser_visible_collect',
    { url: 'https://example.com/old' },
    1000
  )!
  let stored: typeof expired | null = structuredClone(expired)
  let saveCount = 0
  configureActivePlanPersistence({
    load: () => stored,
    save: (_scope, plan) => { saveCount += 1; stored = structuredClone(plan) },
    remove: () => { stored = null },
  })
  t.after(() => {
    resetActivePlansForTests()
    configureActivePlanPersistence(null)
  })
  resetActivePlansForTests()

  noteToolResultForActivePlan(
    'scope-expired',
    'browser_get_task',
    { task_id: 'old-task' },
    1000 + 31 * 60_000,
    JSON.stringify({ taskId: 'old-task', status: 'completed', result: { targets: [{ id: 'n1' }] } })
  )

  assert.equal(stored, null)
  assert.equal(saveCount, 0)
  assert.equal(buildActivePlanReminderText('scope-expired', 1000 + 31 * 60_000), null)
})

test('malformed persisted plans are ignored instead of reaching reminder rendering', (t) => {
  configureActivePlanPersistence({
    load: () => ({
      taskGoal: 'broken', verify: 'evidence', updatedAtMs: 1000, evidence: {},
      steps: [{ id: 'x', title: 'x', advanceOnTools: [], evidenceRequirement: 'unknown', status: 'pending' }],
    } as never),
    save: () => undefined,
    remove: () => undefined,
  })
  t.after(() => {
    resetActivePlansForTests()
    configureActivePlanPersistence(null)
  })
  resetActivePlansForTests()
  assert.equal(buildActivePlanReminderText('scope-malformed', 1100), null)
})

test('plan-persistence-reinjection declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'plan-persistence-reinjection transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test'
} as const

function collectionTool(name: string): ToolDefinition {
  return {
    name,
    groupId: 'browser_content_tasks',
    domain: 'browser',
    kind: 'write',
    concurrency: 'serial',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: `${name} test stub`,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    executionVisibility: 'model',
    resultShape: 'json'
  }
}

test('collection plan derives, advances on tool results, and stays scoped', () => {
  resetActivePlansForTests()
  const plan = deriveCollectionPlanFromToolCall(
    'browser_visible_collect',
    { url: 'https://example.com/u/1' },
    1000
  )
  assert.ok(plan)
  assert.equal(plan?.steps.length, 3)
  assert.equal(plan?.verify, 'evidence')

  noteToolResultForActivePlan(
    'scope-a',
    'browser_visible_collect',
    { url: 'https://example.com/u/1' },
    1000,
    JSON.stringify({ taskId: 'discover-1', status: 'queued' })
  )
  let text = buildActivePlanReminderText('scope-a', 1000)
  assert.ok(
    text && text.includes('当前步骤 1/3'),
    `queued discovery must stay on step 1, got: ${text}`
  )
  assert.doesNotMatch(text || '', /verify=/)
  assert.doesNotMatch(
    text || '',
    /collection_manifest|collection_run|media_download_complete|task_terminal_complete/
  )

  noteToolResultForActivePlan(
    'scope-a',
    'browser_get_task',
    { task_id: 'discover-1' },
    1500,
    JSON.stringify({
      taskId: 'discover-1',
      status: 'completed',
      result: { targets: [{ url: 'a' }, { url: 'b' }] }
    })
  )
  text = buildActivePlanReminderText('scope-a', 1500)
  assert.ok(
    text && text.includes('当前步骤 2/3'),
    `completed non-empty manifest should advance, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-a',
    'browser_collect_notes',
    { source_task_id: 'wrong-discovery', expected_count: 2 },
    1800,
    JSON.stringify({ taskId: 'collect-wrong', status: 'queued' })
  )
  text = buildActivePlanReminderText('scope-a', 1800)
  assert.ok(
    text && text.includes('当前步骤 2/3'),
    `mismatched source handle must not advance, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-a',
    'browser_collect_notes',
    { source_task_id: 'discover-1', expected_count: 2 },
    2000,
    JSON.stringify({ taskId: 'collect-1', status: 'queued' })
  )
  text = buildActivePlanReminderText('scope-a', 2000)
  assert.ok(text && text.includes('当前步骤 3/3'), `expected step 3 current, got: ${text}`)

  noteToolResultForActivePlan(
    'scope-a',
    'browser_get_task',
    { task_id: 'discover-1' },
    2200,
    JSON.stringify({
      taskId: 'discover-1',
      status: 'completed',
      total: 2,
      completed: 2,
      failed: 0,
      remaining: 0
    })
  )
  text = buildActivePlanReminderText('scope-a', 2200)
  assert.ok(
    text && text.includes('当前步骤 3/3'),
    `review must query the execution handle, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-a',
    'browser_get_task',
    { task_id: 'collect-1' },
    2300,
    JSON.stringify({ taskId: 'collect-1', status: 'completed' })
  )
  text = buildActivePlanReminderText('scope-a', 2300)
  assert.ok(
    text && text.includes('当前步骤 3/3'),
    `terminal status without bound counts must not reuse discovery counts, got: ${text}`
  )
  assert.match(text || '', /完整已保存数/)

  noteToolResultForActivePlan(
    'scope-a',
    'browser_get_task',
    { task_id: 'collect-1' },
    2325,
    JSON.stringify({
      taskId: 'collect-1',
      status: 'running',
      completed: 2,
      failed: 0,
      remaining: 0
    })
  )
  noteToolResultForActivePlan(
    'scope-a',
    'browser_get_task',
    { task_id: 'collect-1' },
    2350,
    JSON.stringify({
      taskId: 'collect-1',
      status: 'completed',
      completed: 2,
      failed: null,
      remaining: null
    })
  )
  text = buildActivePlanReminderText('scope-a', 2350)
  assert.ok(
    text && text.includes('当前步骤 3/3'),
    `null or prior-query counts must not be reused as terminal zeros, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-a',
    'browser_get_task',
    { task_id: 'collect-1' },
    2375,
    JSON.stringify({
      taskId: 'collect-1',
      status: 'completed',
      completed: 2.9,
      failed: 0,
      remaining: 0
    })
  )
  text = buildActivePlanReminderText('scope-a', 2375)
  assert.ok(
    text && text.includes('当前步骤 3/3'),
    `fractional counts must not be rounded into valid delivery evidence, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-a',
    'browser_get_task',
    { task_id: 'collect-1' },
    2380,
    JSON.stringify({
      taskId: 'collect-1',
      status: 'completed',
      completed: 2,
      result: { failed: 0, remaining: 0 }
    })
  )
  text = buildActivePlanReminderText('scope-a', 2380)
  assert.ok(
    text && text.includes('当前步骤 3/3'),
    `counts split across nested records must not form one terminal snapshot, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-a',
    'browser_get_task',
    { task_id: 'collect-1' },
    2400,
    JSON.stringify({
      taskId: 'collect-1',
      status: 'completed',
      total: 2,
      completed: 2,
      failed: 0,
      remaining: 0
    })
  )
  text = buildActivePlanReminderText('scope-a', 2400)
  assert.ok(
    text && text.includes('全部 3 步已由结构化证据验证'),
    `complete bound task should close the plan, got: ${text}`
  )

  // other scopes see nothing
  assert.equal(buildActivePlanReminderText('scope-b', 2000), null)

  // stale plans stop injecting
  assert.equal(buildActivePlanReminderText('scope-a', 2000 + 31 * 60_000), null)
})

test('image gallery plan advances from discovery to media download', () => {
  resetActivePlansForTests()
  noteToolResultForActivePlan(
    'scope-media',
    'browser_visible_collect',
    { template: 'image_gallery', url: 'https://example.com/gallery' },
    1000,
    JSON.stringify({
      taskId: 'browser-task-1',
      status: 'completed',
      result: { mediaUrls: ['a', 'b'] }
    })
  )
  let text = buildActivePlanReminderText('scope-media', 1000)
  assert.ok(
    text && text.includes('当前步骤 2/3：下载已发现图片到本地目录'),
    `expected media download step, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-media',
    'browser_download_collected_media',
    { source_task_id: 'browser-task-1', directory: '/tmp/gallery' },
    2000,
    JSON.stringify({
      ok: true,
      completion: 'complete',
      sourceTaskId: 'browser-task-1',
      discovered: 2,
      saved: 1,
      failedCount: 0,
      remaining: 0
    })
  )
  text = buildActivePlanReminderText('scope-media', 2000)
  assert.ok(
    text && text.includes('当前步骤 2/3：下载已发现图片到本地目录'),
    `count-mismatched complete result must stay on step 2, got: ${text}`
  )
})

test('frozen collection count cannot be replaced by smaller or larger download evidence', () => {
  for (const [scope, frozen, reported] of [
    ['scope-frozen-shrink', 10, 5],
    ['scope-frozen-grow', 5, 10]
  ] as const) {
    resetActivePlansForTests()
    noteToolResultForActivePlan(
      scope,
      'browser_visible_collect',
      { template: 'image_gallery', url: 'https://example.com/gallery' },
      1000,
      JSON.stringify({
        taskId: `${scope}-task`,
        status: 'completed',
        result: { mediaUrls: Array.from({ length: frozen }, (_, index) => `image-${index}`) }
      })
    )
    noteToolResultForActivePlan(
      scope,
      'browser_download_collected_media',
      { source_task_id: `${scope}-task`, directory: '/tmp/gallery' },
      2000,
      JSON.stringify({
        ok: true,
        completion: 'complete',
        sourceTaskId: `${scope}-task`,
        discovered: reported,
        saved: reported,
        failedCount: 0,
        remaining: 0
      })
    )
    noteToolResultForActivePlan(
      scope,
      'browser_get_task',
      { task_id: `${scope}-task` },
      3000,
      JSON.stringify({
        taskId: `${scope}-task`,
        status: 'completed',
        result: { mediaDownload: { saved: reported, failed: 0, remaining: 0 } }
      })
    )
    const text = buildActivePlanReminderText(scope, 3000)
    assert.ok(text && text.includes('当前步骤 2/3'), `${frozen}→${reported} must not close: ${text}`)
  }
})

test('collection dispatch arguments cannot manufacture discovery evidence', () => {
  resetActivePlansForTests()
  noteToolResultForActivePlan(
    'scope-forged-manifest',
    'browser_collect_notes',
    { source_task_id: 'forged-discovery', expected_count: 9 },
    1000,
    JSON.stringify({ taskId: 'collect-1', status: 'queued' })
  )
  let text = buildActivePlanReminderText('scope-forged-manifest', 1000)
  assert.ok(
    text && text.includes('当前步骤 1/3'),
    `dispatch arguments must not skip manifest discovery, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-forged-manifest',
    'browser_get_task',
    { task_id: 'forged-discovery' },
    1500,
    JSON.stringify({
      taskId: 'forged-discovery',
      status: 'completed',
      result: { targets: [{ url: 'a' }, { url: 'b' }] }
    })
  )
  text = buildActivePlanReminderText('scope-forged-manifest', 1500)
  assert.ok(
    text && text.includes('当前步骤 3/3'),
    `direct collect handle should become usable only after source-task verification, got: ${text}`
  )
})

test('completed task status does not bless an explicitly partial discovery manifest', () => {
  resetActivePlansForTests()
  noteToolResultForActivePlan(
    'scope-partial-manifest',
    'browser_visible_collect',
    { url: 'https://example.com/u/partial' },
    1000,
    JSON.stringify({
      taskId: 'discover-partial',
      status: 'completed',
      result: { discoveryStatus: 'partial', targets: [{ url: 'a' }, { url: 'b' }] }
    })
  )
  const text = buildActivePlanReminderText('scope-partial-manifest', 1000)
  assert.ok(
    text && text.includes('当前步骤 1/3'),
    `partial manifest must stay on discovery despite completed task status, got: ${text}`
  )
})

test('completed discovery with failed or remaining items does not freeze a manifest', () => {
  for (const [scope, result] of [
    ['scope-discovery-failed', { targets: [{ url: 'a' }], failedItems: [{ url: 'b' }] }],
    ['scope-discovery-remaining', { targets: [{ url: 'a' }], remaining: 1 }]
  ] as const) {
    resetActivePlansForTests()
    noteToolResultForActivePlan(
      scope,
      'browser_visible_collect',
      { url: 'https://example.com/u/incomplete' },
      1000,
      JSON.stringify({ taskId: `${scope}-task`, status: 'completed', result })
    )
    const text = buildActivePlanReminderText(scope, 1000)
    assert.ok(
      text && text.includes('当前步骤 1/3'),
      `incomplete completed discovery must stay on step 1, got: ${text}`
    )
  }
})

test('image gallery review does not complete on partial collected-media downloads', () => {
  resetActivePlansForTests()
  noteToolResultForActivePlan(
    'scope-media-partial',
    'browser_visible_collect',
    { template: 'image_gallery', url: 'https://example.com/gallery' },
    1000,
    JSON.stringify({
      taskId: 'browser-task-1',
      status: 'completed',
      result: { mediaUrls: ['a', 'b'] }
    })
  )
  noteToolResultForActivePlan(
    'scope-media-partial',
    'browser_download_collected_media',
    { source_task_id: 'browser-task-1', directory: '/tmp/gallery' },
    2000,
    JSON.stringify({
      ok: true,
      completion: 'partial',
      sourceTaskId: 'browser-task-1',
      discovered: 2,
      saved: 1,
      remaining: 1,
      failedCount: 0
    })
  )
  let text = buildActivePlanReminderText('scope-media-partial', 2000)
  assert.ok(
    text && text.includes('当前步骤 2/3：下载已发现图片到本地目录'),
    `partial result must keep download pending, got: ${text}`
  )
  assert.match(text || '', /完整完成标记/)

  noteToolResultForActivePlan(
    'scope-media-partial',
    'browser_download_collected_media',
    { source_task_id: 'browser-task-1', directory: '/tmp/gallery' },
    2250,
    JSON.stringify({
      ok: true,
      completion: 'partial',
      discovered: 2,
      saved: 2,
      failedCount: 0,
      remaining: 0
    })
  )
  noteToolResultForActivePlan(
    'scope-media-partial',
    'browser_download_collected_media',
    { source_task_id: 'browser-task-1', directory: '/tmp/gallery' },
    2300,
    JSON.stringify({ ok: true, completion: 'complete' })
  )
  text = buildActivePlanReminderText('scope-media-partial', 2300)
  assert.ok(
    text && text.includes('当前步骤 2/3'),
    `complete marker must not reuse counts from a previous download result, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-media-partial',
    'browser_download_collected_media',
    { source_task_id: 'browser-task-1', directory: '/tmp/gallery' },
    3000,
    JSON.stringify({ ok: true })
  )
  text = buildActivePlanReminderText('scope-media-partial', 3000)
  assert.ok(
    text && text.includes('当前步骤 2/3：下载已发现图片到本地目录'),
    `ok-only result must not advance, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-media-partial',
    'browser_get_task',
    { task_id: 'browser-task-1' },
    3500,
    JSON.stringify({
      taskId: 'browser-task-1',
      status: 'paused',
      result: { mediaDownload: { saved: 1, failed: 0, remaining: 1 } }
    })
  )
  text = buildActivePlanReminderText('scope-media-partial', 3500)
  assert.ok(
    text && text.includes('当前步骤 2/3：下载已发现图片到本地目录'),
    `open browser task must keep download pending, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-media-partial',
    'browser_download_collected_media',
    { source_task_id: 'browser-task-1', directory: '/tmp/gallery' },
    4000,
    JSON.stringify({
      ok: true,
      completion: 'complete',
      sourceTaskId: 'browser-task-1',
      discovered: 2,
      saved: 2,
      remaining: 0,
      failedCount: 0
    })
  )
  text = buildActivePlanReminderText('scope-media-partial', 4000)
  assert.ok(
    text && text.includes('当前步骤 3/3'),
    `download completion still requires a bound terminal review, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-media-partial',
    'browser_get_task',
    { task_id: 'browser-task-1' },
    4500,
    JSON.stringify({ taskId: 'browser-task-1', status: 'completed' })
  )
  text = buildActivePlanReminderText('scope-media-partial', 4500)
  assert.ok(
    text && text.includes('当前步骤 3/3'),
    `completed status without reviewed delivery counts must not close, got: ${text}`
  )

  noteToolResultForActivePlan(
    'scope-media-partial',
    'browser_get_task',
    { task_id: 'browser-task-1' },
    5000,
    JSON.stringify({
      taskId: 'browser-task-1',
      status: 'completed',
      result: { mediaDownload: { saved: 2, failed: 0, remaining: 0 } }
    })
  )
  text = buildActivePlanReminderText('scope-media-partial', 5000)
  assert.ok(
    text && text.includes('全部 3 步已由结构化证据验证'),
    `bound terminal review with complete counts should close, got: ${text}`
  )
})

test('next turn model input carries the re-injected current plan step', async () => {
  resetActivePlansForTests()
  const inputs: string[] = []
  let turn = 0
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [
      collectionTool('browser_visible_collect'),
      collectionTool('browser_collect_notes')
    ],
    executeToolCall: async () =>
      createToolExecutionOutput('ok', {
        shape: 'json',
        data: {
          taskId: 'visible-1',
          status: 'completed',
          result: { targets: [{ url: 'https://example.com/n/1' }] }
        }
      }),
    runAgent: async ({ input, tools }) => {
      inputs.push(typeof input === 'string' ? input : JSON.stringify(input))
      turn += 1
      if (turn === 1) {
        const dispatch = (
          tools as Array<{ name: string; invoke: (ctx: unknown, raw: string) => Promise<string> }>
        ).find((toolItem) => toolItem.name === 'browser_visible_collect')
        assert.ok(dispatch)
        await dispatch!.invoke({}, JSON.stringify({ url: 'https://example.com/u/1' }))
        return { finalText: '已启动清单发现。', toolTrace: [{ name: 'browser_visible_collect' }] }
      }
      return { finalText: '收到。', toolTrace: [] }
    }
  } as Partial<AgentSdkRuntimeDeps> as AgentSdkRuntimeDeps)

  runtime.newSession('butler::scope-plan', 'system prompt')
  await runtime.sendMessage('butler::scope-plan', '把这个博主的全部笔记采集下来', 'run-plan-1', {})
  await runtime.sendMessage('butler::scope-plan', '继续', 'run-plan-2', {})

  assert.equal(inputs.length >= 2, true)
  const secondTurnInput = inputs[1]
  assert.ok(
    secondTurnInput.includes('[活动计划]'),
    `expected plan reminder in second turn input, got: ${secondTurnInput.slice(0, 200)}`
  )
  assert.ok(
    secondTurnInput.includes('当前步骤 2/3'),
    'expected current step 2 after discovery completed'
  )
})
