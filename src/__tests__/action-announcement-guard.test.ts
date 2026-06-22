import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { evaluateActionAnnouncementGuard } from '../main/modules/agent-control/runtime-core/action-announcement-guard'
import { canResumeShape } from '../main/modules/agent-control/contracts/resume-handle'
import { ScriptedAgentRunner } from './helpers/scripted-agent-runner'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('action-announcement-guard declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'action-announcement-guard transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

class MemoryRunMetaRepository {
  readonly rows = new Map<string, Record<string, unknown>>()

  get(runId: string): Record<string, unknown> | null {
    return this.rows.get(runId) || null
  }

  create(input: Record<string, unknown>): Record<string, unknown> {
    this.rows.set(String(input.runId), { ...input })
    return input
  }

  update(runId: string, patch: Record<string, unknown>): Record<string, unknown> | null {
    const next = { ...(this.rows.get(runId) || {}), ...patch }
    this.rows.set(runId, next)
    return next
  }
}

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): {
  runtime: AgentSdkRuntime
  repository: MemoryRunMetaRepository
  outputs: Array<{ chunk: string; type: string }>
} {
  const repository = new MemoryRunMetaRepository()
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    ...deps,
  })
  runtime.setRuntime({
    getRunMetaRepository: () => repository,
  } as never)
  const outputs: Array<{ chunk: string; type: string }> = []
  runtime.on('output', (event) => outputs.push({
    chunk: String(event.chunk || ''),
    type: String(event.type || ''),
  }))
  runtime.on('error', () => undefined)
  return { runtime, repository, outputs }
}

describe('action announcement guard', () => {
  test('steers when the current response promises action after earlier prep tools', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText: '已有 `2026 世界杯` 文件夹。我来并行搜索各届关键视觉图片的可下载源：',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: false,
    })

    assert.equal(decision.kind, 'steer')
  })

  test('checkpoints when a steered response promises to download without calling tools', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText: '好的，已经收集到足够的图片 URL 了！现在批量下载到文件夹里。',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: true,
    })

    assert.equal(decision.kind, 'checkpoint')
  })

  test('steers when a file workflow promises to create the next document', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText: '好，笔记已移入新文件夹。现在创建"图片原文"文档——基于笔记内容还原小红书图片帖的逐图原文。',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: false,
    })

    assert.equal(decision.kind, 'steer')
  })

  test('steers once when an active task ends with an action announcement and no tools', async () => {
    let sawSteerReminder = false
    const scripted = new ScriptedAgentRunner({}, [
      {
        turnIndex: 0,
        response: '让我先打开这篇笔记：',
      },
      {
        turnIndex: 1,
        response: '我没有可调用工具，无法打开笔记。',
        assertions: ({ messages }) => {
          const input = messages.find((message) =>
            typeof message === 'object'
            && message !== null
            && (message as { turnIndex?: unknown }).turnIndex === 1
            && Object.prototype.hasOwnProperty.call(message, 'input')
          )
          sawSteerReminder = /上一轮用行动宣告结尾但没有调用工具/.test(JSON.stringify(input))
        },
      },
    ])
    const { runtime } = createRuntime(scripted.deps)
    runtime.newSession('butler::scope-action-steer', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-action-steer',
      '请打开这篇笔记继续处理',
      'run-action-steer',
      {
        publicSessionId: 'scope-action-steer',
        taskId: 'task-action-steer',
      },
    )

    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'done')
    assert.equal(sawSteerReminder, true)
  })

  test('checkpoints when the steered continuation still has no tool call', async () => {
    const scripted = new ScriptedAgentRunner({}, [
      {
        turnIndex: 0,
        response: '让我先打开这篇笔记：',
      },
      {
        turnIndex: 1,
        response: '接下来我马上处理：',
      },
    ])
    const { runtime, repository, outputs } = createRuntime(scripted.deps)
    runtime.newSession('butler::scope-action-checkpoint', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-action-checkpoint',
      '请打开这篇笔记继续处理',
      'run-action-checkpoint',
      {
        publicSessionId: 'scope-action-checkpoint',
        taskId: 'task-action-checkpoint',
      },
    )

    assert.equal(result.success, true)
    assert.equal(result.status, 'checkpoint')
    assert.equal(result.terminalReason, 'checkpoint_steered')
    assert.match(result.finalText, /未能启动/)
    assert.match(result.finalText, /回复'继续'可恢复/)
    assert.ok(outputs.some((event) => event.chunk.includes('已保存断点')))

    const continuation = result.projectionTruth?.projectionPatch?.taskContinuation as {
      outputDir?: string | null
      runStatePath?: string | null
    } | undefined
    assert.equal(canResumeShape(continuation), true)
    assert.ok(continuation?.runStatePath)
    const state = JSON.parse(await readFile(continuation.runStatePath, 'utf8')) as {
      terminalReason?: string
    }
    assert.equal(state.terminalReason, 'checkpoint_steered')

    const row = repository.get('run-action-checkpoint')
    assert.equal(row?.status, 'checkpoint')
    assert.equal(row?.terminalReason, 'checkpoint_steered')
  })

  test('does not trigger for ordinary conversation without active task context', async () => {
    let unexpectedContinuation = false
    const scripted = new ScriptedAgentRunner({}, [
      {
        turnIndex: 0,
        response: '让我先想一下：',
      },
      {
        turnIndex: 1,
        response: 'unexpected',
        assertions: () => {
          unexpectedContinuation = true
        },
      },
    ])
    const { runtime } = createRuntime(scripted.deps)
    runtime.newSession('butler::scope-action-chat', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-action-chat',
      '随便聊两句',
      'run-action-chat',
    )

    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'done')
    assert.equal(result.finalText, '让我先想一下：')
    assert.equal(unexpectedContinuation, false)
  })
})
