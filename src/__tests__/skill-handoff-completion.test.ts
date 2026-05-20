import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  completePendingSkillHandoffs,
  listPendingSkillHandoffTasks,
} from '../main/modules/agent-control/skills/skill-handoff-completion'
import {
  readSkillHandoffStates,
} from '../main/modules/agent-control/skills/skill-agent-handoff'
import type { AgentSpawnContext } from '../shared/skill-host-contract'

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const agentContext: AgentSpawnContext = {
  provider: 'xiaomi',
  model_id: 'mimo-v2.5',
  base_url: 'https://example.test/v1',
  api_key: 'test-key',
  api_kind: 'openai-completions',
  fallback_chain: [],
  input_modes: ['text'],
}

test('skill handoff completion writes pending output and marks receipt completed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-handoff-completion-'))
  writeJson(join(root, 'audiovisual_handoff', 'receipt.json'), {
    tasks: {
      body: {
        status: 'pending',
        task: 'audiovisual_handoff/body/task.md',
        output: 'audiovisual_handoff/body/output.md',
      },
    },
  })
  mkdirSync(join(root, 'audiovisual_handoff', 'body'), { recursive: true })
  writeFileSync(join(root, 'audiovisual_handoff', 'body', 'task.md'), 'write the body', 'utf8')
  const requests: unknown[] = []
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body || '{}')))
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'completed body text' } }],
    }), { status: 200 })
  }) as typeof fetch

  assert.equal(listPendingSkillHandoffTasks(root).length, 1)
  const completed = await completePendingSkillHandoffs({
    outputDir: root,
    agentContext,
    fetchImpl: fakeFetch,
  })

  assert.equal(completed.length, 1)
  assert.equal(completed[0].name, 'body')
  assert.equal(readFileSync(join(root, 'audiovisual_handoff', 'body', 'output.md'), 'utf8'), 'completed body text')
  const receipt = JSON.parse(readFileSync(join(root, 'audiovisual_handoff', 'receipt.json'), 'utf8'))
  assert.equal(receipt.tasks.body.status, 'completed')
  assert.equal(requests.length, 1)
})

test('skill handoff state reader returns user-safe structured state', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-handoff-state-'))
  writeJson(join(root, 'audiovisual_handoff', 'receipt.json'), {
    tasks: {
      body: {
        status: 'pending_retry',
        task: 'audiovisual_handoff/body/task.md',
        output: 'audiovisual_handoff/body/output.md',
        attempt_count: 1,
        last_error_kind: 'handoff_timeout',
        last_error_message: 'This operation was aborted',
        updated_at: '2026-05-04T00:00:00.000Z',
      },
    },
  })

  const states = readSkillHandoffStates(root)

  assert.equal(states.length, 1)
  assert.deepEqual(states[0], {
    status: 'pending_retry',
    kind: 'audiovisual_report',
    taskName: 'body',
    userMessage: '视听报告正文生成超时，可继续重试。',
    actionLabel: '继续生成报告',
    attemptCount: 1,
    lastErrorKind: 'handoff_timeout',
    lastErrorMessage: '报告生成超时，可继续重试',
    taskPath: join(root, 'audiovisual_handoff', 'body', 'task.md'),
    outputPath: join(root, 'audiovisual_handoff', 'body', 'output.md'),
    updatedAt: '2026-05-04T00:00:00.000Z',
  })
  assert.ok(!states[0].userMessage.includes('audiovisual_handoff'))
  assert.ok(!states[0].userMessage.includes('task.md'))
})

test('skill handoff completion records in-progress and pending retry on timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-handoff-timeout-'))
  writeJson(join(root, 'audiovisual_handoff', 'receipt.json'), {
    tasks: {
      body: {
        status: 'pending',
        task: 'audiovisual_handoff/body/task.md',
        output: 'audiovisual_handoff/body/output.md',
      },
    },
  })
  mkdirSync(join(root, 'audiovisual_handoff', 'body'), { recursive: true })
  writeFileSync(join(root, 'audiovisual_handoff', 'body', 'task.md'), 'write the body', 'utf8')
  const observedStatuses: string[] = []
  const fakeFetch = (async () => {
    const receipt = JSON.parse(readFileSync(join(root, 'audiovisual_handoff', 'receipt.json'), 'utf8'))
    observedStatuses.push(receipt.tasks.body.status)
    throw new DOMException('This operation was aborted', 'AbortError')
  }) as typeof fetch

  await assert.rejects(
    completePendingSkillHandoffs({
      outputDir: root,
      agentContext,
      fetchImpl: fakeFetch,
    }),
    /报告生成超时，可继续重试/,
  )

  assert.deepEqual(observedStatuses, ['in_progress'])
  const receipt = JSON.parse(readFileSync(join(root, 'audiovisual_handoff', 'receipt.json'), 'utf8'))
  assert.equal(receipt.tasks.body.status, 'pending_retry')
  assert.equal(receipt.tasks.body.attempt_count, 1)
  assert.equal(receipt.tasks.body.last_error_kind, 'handoff_timeout')
  assert.equal(receipt.tasks.body.last_error_message, '报告生成超时，可继续重试')
  assert.ok(typeof receipt.tasks.body.updated_at === 'string')
})

test('skill handoff completion marks third failed attempt as failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-handoff-failed-'))
  writeJson(join(root, 'audiovisual_handoff', 'receipt.json'), {
    tasks: {
      body: {
        status: 'pending_retry',
        task: 'audiovisual_handoff/body/task.md',
        output: 'audiovisual_handoff/body/output.md',
        attempt_count: 2,
      },
    },
  })
  mkdirSync(join(root, 'audiovisual_handoff', 'body'), { recursive: true })
  writeFileSync(join(root, 'audiovisual_handoff', 'body', 'task.md'), 'write the body', 'utf8')
  const fakeFetch = (async () => {
    return new Response('upstream failed', { status: 500 })
  }) as typeof fetch

  await assert.rejects(
    completePendingSkillHandoffs({
      outputDir: root,
      agentContext,
      fetchImpl: fakeFetch,
    }),
    /handoff model failed/,
  )

  const receipt = JSON.parse(readFileSync(join(root, 'audiovisual_handoff', 'receipt.json'), 'utf8'))
  assert.equal(receipt.tasks.body.status, 'failed')
  assert.equal(receipt.tasks.body.attempt_count, 3)
  assert.equal(receipt.tasks.body.last_error_kind, 'handoff_model_failed')
  assert.match(receipt.tasks.body.last_error_message, /handoff model failed/)
})

test('skill handoff completion uses single-flight for duplicate handoff calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-handoff-single-flight-'))
  writeJson(join(root, 'audiovisual_handoff', 'receipt.json'), {
    tasks: {
      body: {
        status: 'pending',
        task: 'audiovisual_handoff/body/task.md',
        output: 'audiovisual_handoff/body/output.md',
      },
    },
  })
  mkdirSync(join(root, 'audiovisual_handoff', 'body'), { recursive: true })
  writeFileSync(join(root, 'audiovisual_handoff', 'body', 'task.md'), 'write the body', 'utf8')
  let requestCount = 0
  let releaseFetch!: () => void
  let markFetchStarted!: () => void
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve
  })
  const fetchCanFinish = new Promise<void>((resolve) => {
    releaseFetch = resolve
  })
  const fakeFetch = (async () => {
    requestCount += 1
    markFetchStarted()
    await fetchCanFinish
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'completed once' } }],
    }), { status: 200 })
  }) as typeof fetch

  const first = completePendingSkillHandoffs({ outputDir: root, agentContext, fetchImpl: fakeFetch })
  await fetchStarted
  const second = completePendingSkillHandoffs({ outputDir: root, agentContext, fetchImpl: fakeFetch })
  releaseFetch()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(firstResult.length, 1)
  assert.equal(secondResult.length, 1)
  assert.equal(requestCount, 1)
  assert.equal(readFileSync(join(root, 'audiovisual_handoff', 'body', 'output.md'), 'utf8'), 'completed once')
})

test('skill handoff completion retries long SVG tasks with compact prompt after empty model output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-handoff-svg-compact-'))
  writeJson(join(root, 'audiovisual_handoff', 'receipt.json'), {
    tasks: {
      diagram: {
        status: 'pending',
        task: 'audiovisual_handoff/diagram/task.md',
        output: 'diagram/output.svg',
      },
    },
  })
  mkdirSync(join(root, 'audiovisual_handoff', 'diagram'), { recursive: true })
  const filler = '不要让这段长报告原文进入第二次请求。'.repeat(1600)
  writeFileSync(join(root, 'audiovisual_handoff', 'diagram', 'task.md'), [
    '# 视听剖析 · 子任务：SVG 结构图',
    '### 标题行规格',
    '<text class="ts" x="124" y="28">形式约束（操作源）</text>',
    '<text class="ts" x="340" y="28">感知干预（效果机制）</text>',
    '<text class="ts" x="556" y="28">认识论效应（观者终点）</text>',
    '水平箭头严格为 左→中→右。',
    '视频标题：C3-sample-video',
    '子类型：形式实验',
    '## 形式约束识别',
    '全黑画面取消空间信息。',
    '## 感知干预地图',
    '00:00:00 → 00:00:05 初始冲击与搜索。',
    '00:00:05 → 00:00:20 持续适应与时间感扭曲。',
    '00:00:20 → 00:00:30 接受与物质性浮现。',
    '## 边界测试',
    '这还是电影/视频吗？',
    filler,
  ].join('\n'), 'utf8')
  const requests: unknown[] = []
  const anthropicContext: AgentSpawnContext = {
    ...agentContext,
    api_kind: 'anthropic-messages',
    base_url: 'https://example.test/anthropic',
  }
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as { messages?: Array<{ content?: string }> }
    requests.push(body)
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        content: [{ type: 'thinking', thinking: 'I know the SVG rows but did not emit text.' }],
      }), { status: 200 })
    }
    const sentPrompt = String(body.messages?.[0]?.content || '')
    assert.ok(sentPrompt.length < filler.length)
    assert.match(sentPrompt, /compact task packet/)
    return new Response(JSON.stringify({
      content: [{
        type: 'text',
        text: '<svg role="img" width="100%" viewBox="0 0 680 340"><title>结构图</title><desc>结构图</desc><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9"/></marker></defs><text class="ts" x="124" y="28">形式约束（操作源）</text><text class="ts" x="340" y="28">感知干预（效果机制）</text><text class="ts" x="556" y="28">认识论效应（观者终点）</text><line class="arr" x1="208" y1="78" x2="254" y2="78" marker-end="url(#arrow)"/></svg>',
      }],
    }), { status: 200 })
  }) as typeof fetch

  const completed = await completePendingSkillHandoffs({
    outputDir: root,
    agentContext: anthropicContext,
    fetchImpl: fakeFetch,
  })

  assert.equal(completed.length, 1)
  assert.equal(completed[0].name, 'diagram')
  assert.equal(requests.length, 2)
  assert.match(readFileSync(join(root, 'audiovisual_handoff', 'diagram', 'output.svg'), 'utf8'), /<svg/)
  const receipt = JSON.parse(readFileSync(join(root, 'audiovisual_handoff', 'receipt.json'), 'utf8'))
  assert.equal(receipt.tasks.diagram.status, 'completed')
})

test('skill handoff validation repair also uses single-flight for duplicate calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-handoff-repair-single-flight-'))
  writeJson(join(root, 'audiovisual_handoff', 'receipt.json'), {
    tasks: {
      body: {
        status: 'completed',
        task: 'audiovisual_handoff/body/task.md',
        output: 'audiovisual_handoff/body/output.md',
      },
    },
  })
  mkdirSync(join(root, 'audiovisual_handoff', 'body'), { recursive: true })
  writeFileSync(join(root, 'audiovisual_handoff', 'body', 'task.md'), 'repair the body', 'utf8')
  writeFileSync(join(root, 'audiovisual_handoff', 'body', 'output.md'), 'old output', 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 5))
  writeJson(join(root, 'audiovisual_handoff', 'body', 'validation_errors.json'), {
    errors: ['missing section'],
  })
  let requestCount = 0
  let releaseFetch!: () => void
  let markFetchStarted!: () => void
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve
  })
  const fetchCanFinish = new Promise<void>((resolve) => {
    releaseFetch = resolve
  })
  const fakeFetch = (async () => {
    requestCount += 1
    markFetchStarted()
    await fetchCanFinish
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'repaired once' } }],
    }), { status: 200 })
  }) as typeof fetch

  const first = completePendingSkillHandoffs({ outputDir: root, agentContext, fetchImpl: fakeFetch })
  await fetchStarted
  const receiptDuringRepair = JSON.parse(readFileSync(join(root, 'audiovisual_handoff', 'receipt.json'), 'utf8'))
  const second = completePendingSkillHandoffs({ outputDir: root, agentContext, fetchImpl: fakeFetch })
  releaseFetch()
  const [firstResult, secondResult] = await Promise.all([first, second])

  assert.equal(receiptDuringRepair.tasks.body.status, 'in_progress')
  assert.equal(firstResult.length, 1)
  assert.equal(secondResult.length, 1)
  assert.equal(firstResult[0].repairedValidation, true)
  assert.equal(secondResult[0].repairedValidation, true)
  assert.equal(requestCount, 1)
  assert.equal(readFileSync(join(root, 'audiovisual_handoff', 'body', 'output.md'), 'utf8'), 'repaired once')
})
