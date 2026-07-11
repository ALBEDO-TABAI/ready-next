import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { evaluateActionAnnouncementGuard } from '../main/modules/agent-control/runtime-core/action-announcement-guard'
import {
  buildSkillClarificationCheckpointMessage,
  evaluateSkillClarificationGuard
} from '../main/modules/agent-control/runtime-core/skill-clarification-guard'
import { canResumeShape } from '../main/modules/agent-control/contracts/resume-handle'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { ScriptedAgentRunner } from './helpers/scripted-agent-runner'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('action-announcement-guard declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'action-announcement-guard transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test'
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
    ...deps
  })
  runtime.setRuntime({
    getRunMetaRepository: () => repository
  } as never)
  const outputs: Array<{ chunk: string; type: string }> = []
  runtime.on('output', (event) =>
    outputs.push({
      chunk: String(event.chunk || ''),
      type: String(event.type || '')
    })
  )
  runtime.on('error', () => undefined)
  return { runtime, repository, outputs }
}

function createSkillAskUserToolDefinition(): ToolDefinition {
  return {
    name: 'skill_ask_user',
    groupId: 'skills',
    domain: 'skill',
    kind: 'interactive',
    concurrency: 'serialized',
    interruptBehavior: 'host_managed',
    timeoutProfile: 'skill',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: false },
    description: 'Ask the user a clarification question for the active skill.',
    schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array' }
      },
      required: ['question'],
      additionalProperties: false
    },
    executionVisibility: 'model',
    resultShape: 'json'
  }
}

function createBrowserToolDefinition(name: string = 'browser_capture_viewport'): ToolDefinition {
  return {
    name,
    groupId: 'browser_interaction',
    domain: 'browser',
    kind: 'read',
    concurrency: 'serialized',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'browser',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: 'Browser test tool.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    executionVisibility: 'model',
    resultShape: 'json'
  }
}

describe('action announcement guard', () => {
  test('steers when the current response promises action after earlier prep tools', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText: '已有 `2026 世界杯` 文件夹。我来并行搜索各届关键视觉图片的可下载源：',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: false
    })

    assert.equal(decision.kind, 'steer')
  })

  test('steers when a browser workflow says it will click or switch tabs without tools', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText: '页面当前在"上传视频"标签页，我需要先切换到"上传图文"。让我点击切换。',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: false
    })

    assert.equal(decision.kind, 'steer')
  })

  test('steers when a browser workflow says it will tap the next option', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText:
        '现在页面已经切换到"上传图文"模式。我看到有"上传图片"和"文字配图"两个选项。你只需要发纯文字，我先点"文字配图"看看。',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: false
    })

    assert.equal(decision.kind, 'steer')
  })

  test('steers when a browser workflow infers the next click but does not call a tool', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText:
        '好！页面已经切换到"上传图文"模式了。我看到有"上传图片"和"文字配图"两个选项。用户想要的是"生成图片"，应该就是点击"文字配图"按钮。',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: false
    })

    assert.equal(decision.kind, 'steer')
  })

  test('checkpoints when a steered response promises to download without calling tools', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText: '好的，已经收集到足够的图片 URL 了！现在批量下载到文件夹里。',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: true
    })

    assert.equal(decision.kind, 'checkpoint')
  })

  test('checkpoints when a steered browser workflow still only promises clicking', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText: '我需要先切换到"上传图文"。让我点击切换。',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: true
    })

    assert.equal(decision.kind, 'checkpoint')
  })

  test('checkpoints when a steered browser workflow still only promises tapping', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText: '我先点"文字配图"看看。',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: true
    })

    assert.equal(decision.kind, 'checkpoint')
  })

  test('steers when a file workflow promises to create the next document', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText:
        '好，笔记已移入新文件夹。现在创建"图片原文"文档——基于笔记内容还原小红书图片帖的逐图原文。',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: false
    })

    assert.equal(decision.kind, 'steer')
  })

  test('steers when a document workflow says it will start writing files', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText: '好，文件夹已存在，直接开始写入。先写设计方案文档，再写效果图 Prompt 文档。',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: false
    })

    assert.equal(decision.kind, 'steer')
  })

  test('checkpoints when the steered document workflow still only promises writing', () => {
    const decision = evaluateActionAnnouncementGuard({
      assistantText: '好，文件夹已存在，直接开始写入。先写设计方案文档，再写效果图 Prompt 文档。',
      toolCallsInCurrentResponse: 0,
      hasUnfinishedTaskReference: true,
      alreadySteered: true
    })

    assert.equal(decision.kind, 'checkpoint')
  })

  test('steers once when an active task ends with an action announcement and no tools', async () => {
    let sawSteerReminder = false
    const scripted = new ScriptedAgentRunner({}, [
      {
        turnIndex: 0,
        response: '让我先打开这篇笔记：'
      },
      {
        turnIndex: 1,
        response: '我没有可调用工具，无法打开笔记。',
        assertions: ({ messages }) => {
          const input = messages.find(
            (message) =>
              typeof message === 'object' &&
              message !== null &&
              (message as { turnIndex?: unknown }).turnIndex === 1 &&
              Object.prototype.hasOwnProperty.call(message, 'input')
          )
          sawSteerReminder = /上一轮用行动宣告结尾但没有调用工具/.test(JSON.stringify(input))
        }
      }
    ])
    const { runtime } = createRuntime(scripted.deps)
    runtime.newSession('butler::scope-action-steer', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-action-steer',
      '请打开这篇笔记继续处理',
      'run-action-steer',
      {
        publicSessionId: 'scope-action-steer',
        taskId: 'task-action-steer'
      }
    )

    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'done')
    assert.equal(sawSteerReminder, true)
  })

  test('runtime steers a browser click/switch announcement instead of closing degraded', async () => {
    let sawSteerReminder = false
    let turnIndex = 0
    const toolDefinition = createBrowserToolDefinition()
    const { runtime } = createRuntime({
      listToolDefinitions: () => [toolDefinition],
      executeToolCall: async () =>
        createToolExecutionOutput('viewport captured', {
          shape: 'json',
          data: { ok: true }
        }),
      runAgent: async ({ input, tools, onTextDelta }) => {
        if (turnIndex === 0) {
          const capture = tools.find((tool) => tool.name === 'browser_capture_viewport') as
            | {
                invoke: (context: unknown, rawInput: string) => Promise<string>
              }
            | undefined
          assert.ok(capture)
          await capture.invoke({}, JSON.stringify({}))
          const response = '页面当前在"上传视频"标签页，我需要先切换到"上传图文"。让我点击切换。'
          onTextDelta(response)
          turnIndex += 1
          return { finalText: response }
        }
        sawSteerReminder = /上一轮用行动宣告结尾但没有调用工具/.test(JSON.stringify(input))
        const response = '我没有可调用工具，无法点击切换。'
        onTextDelta(response)
        turnIndex += 1
        return { finalText: response }
      }
    })
    runtime.newSession('butler::scope-browser-action-steer', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-browser-action-steer',
      '帮我发布小红书',
      'run-browser-action-steer',
      {
        publicSessionId: 'scope-browser-action-steer',
        taskId: 'task-browser-action-steer'
      }
    )

    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'done')
    assert.equal(sawSteerReminder, true)
  })

  test('runtime allows a fresh action-announcement steer after real tool progress', async () => {
    let sawSecondSteerReminder = false
    let turnIndex = 0
    const toolDefinition = createBrowserToolDefinition('browser_read_page_map')
    const { runtime } = createRuntime({
      listToolDefinitions: () => [toolDefinition],
      executeToolCall: async () =>
        createToolExecutionOutput('page map read', {
          shape: 'json',
          data: { ok: true }
        }),
      runAgent: async ({ input, tools, onTextDelta }) => {
        if (turnIndex === 0) {
          const readMap = tools.find((tool) => tool.name === 'browser_read_page_map') as
            | {
                invoke: (context: unknown, rawInput: string) => Promise<string>
              }
            | undefined
          assert.ok(readMap)
          await readMap.invoke({}, JSON.stringify({}))
          const response =
            '页面当前在"上传视频"标签页，我需要先切换到"上传图文"。让我点击"上传图文"。'
          onTextDelta(response)
          turnIndex += 1
          return { finalText: response }
        }
        if (turnIndex === 1) {
          const readMap = tools.find((tool) => tool.name === 'browser_read_page_map') as
            | {
                invoke: (context: unknown, rawInput: string) => Promise<string>
              }
            | undefined
          assert.ok(readMap)
          await readMap.invoke({}, JSON.stringify({}))
          const response =
            '现在页面已经切换到"上传图文"模式。我看到有"上传图片"和"文字配图"两个选项。你只需要发纯文字，我先点"文字配图"看看。'
          onTextDelta(response)
          turnIndex += 1
          return { finalText: response }
        }
        sawSecondSteerReminder = /上一轮用行动宣告结尾但没有调用工具/.test(JSON.stringify(input))
        const response = '我没有可调用工具，无法点击文字配图。'
        onTextDelta(response)
        turnIndex += 1
        return { finalText: response }
      }
    })
    runtime.newSession('butler::scope-browser-action-resteer', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-browser-action-resteer',
      '帮我发布小红书',
      'run-browser-action-resteer',
      {
        publicSessionId: 'scope-browser-action-resteer',
        taskId: 'task-browser-action-resteer'
      }
    )

    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'done')
    assert.equal(sawSecondSteerReminder, true)
  })

  test('checkpoints when the steered continuation still has no tool call', async () => {
    let modelTurn = 0
    const { runtime, repository, outputs } = createRuntime({
      runAgent: async ({ onTextDelta }) => {
        const response = modelTurn === 0 ? '让我先打开这篇笔记：' : '接下来我马上处理：'
        const usage =
          modelTurn === 0
            ? { inputTokens: 11, outputTokens: 4, totalTokens: 15 }
            : { inputTokens: 21, outputTokens: 8, totalTokens: 29 }
        modelTurn += 1
        onTextDelta(response)
        return { finalText: response, usage }
      }
    })
    runtime.newSession('butler::scope-action-checkpoint', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-action-checkpoint',
      '请打开这篇笔记继续处理',
      'run-action-checkpoint',
      {
        publicSessionId: 'scope-action-checkpoint',
        taskId: 'task-action-checkpoint'
      }
    )

    assert.equal(result.success, true)
    assert.equal(result.status, 'checkpoint')
    assert.equal(result.terminalReason, 'checkpoint_steered')
    assert.equal(result.contextUsage?.usedInputTokens, 32)
    assert.match(result.finalText, /未能启动/)
    assert.match(result.finalText, /回复'继续'可恢复/)
    assert.ok(outputs.some((event) => event.chunk.includes('已保存断点')))

    const continuation = result.projectionTruth?.projectionPatch?.taskContinuation as
      | {
          outputDir?: string | null
          runStatePath?: string | null
        }
      | undefined
    assert.equal(canResumeShape(continuation), true)
    assert.ok(continuation?.runStatePath)
    const state = JSON.parse(await readFile(continuation.runStatePath, 'utf8')) as {
      terminalReason?: string
    }
    assert.equal(state.terminalReason, 'checkpoint_steered')

    const row = repository.get('run-action-checkpoint')
    assert.equal(row?.status, 'checkpoint')
    assert.equal(row?.terminalReason, 'checkpoint_steered')
    assert.deepEqual(row?.continuationRef, continuation)
    assert.equal(row?.lastMessageText, result.finalText)
    assert.equal(row?.inputTokens, 32)
    assert.equal(row?.outputTokens, 12)
  })

  test('does not trigger for ordinary conversation without active task context', async () => {
    let unexpectedContinuation = false
    const scripted = new ScriptedAgentRunner({}, [
      {
        turnIndex: 0,
        response: '让我先想一下：'
      },
      {
        turnIndex: 1,
        response: 'unexpected',
        assertions: () => {
          unexpectedContinuation = true
        }
      }
    ])
    const { runtime } = createRuntime(scripted.deps)
    runtime.newSession('butler::scope-action-chat', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-action-chat',
      '随便聊两句',
      'run-action-chat'
    )

    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'done')
    assert.equal(result.finalText, '让我先想一下：')
    assert.equal(unexpectedContinuation, false)
  })
})

describe('skill clarification guard', () => {
  const hfpClarificationText = [
    '好问题。当前方案是基于假设推进的，有几块信息如果能补上，方案会更落地：',
    '',
    '最能提升方案质量的 5 个信息',
    '',
    '① 主推产品或系列',
    '> 当前假设是 hfpTM 全线，重点提了精华/面霜/果酸线。如果你有明确的主推款，我可以把入口 C 位、壁龛分区、试用台陈列都围绕它重新排布。',
    '',
    '② 触点类型和面积',
    '> 当前假设是 20-40m² 独立门店或商场中庭快闪。实际是哪种？',
    '',
    '③ 空间的核心目标优先级',
    '> 当前排的是“产品识别 + 试用体验 + 低压咨询”。如果你更看重吸引进店、成交转化、用户返图传播，动线权重会不同。'
  ].join('\n')

  test('steers skill clarification lists into skill_ask_user', () => {
    const decision = evaluateSkillClarificationGuard({
      assistantText: hfpClarificationText,
      toolCallsInCurrentResponse: 0,
      hasSkillAskUserTool: true,
      isSkillClarificationEligible: true,
      hasUnfinishedTaskReference: true,
      alreadySteered: false
    })

    assert.equal(decision.kind, 'steer')
  })

  test('does not steer optional improvement advice', () => {
    const decision = evaluateSkillClarificationGuard({
      assistantText: '可以补充主推产品、门店面积和核心目标，但我也可以先按默认假设继续。',
      toolCallsInCurrentResponse: 0,
      hasSkillAskUserTool: true,
      isSkillClarificationEligible: true,
      hasUnfinishedTaskReference: false,
      alreadySteered: false
    })

    assert.equal(decision.kind, 'none')
  })

  test('does not steer post-completion adjustment offers into ask-user cards', () => {
    const decision = evaluateSkillClarificationGuard({
      assistantText: '方案已完成，文件已保存。需要我继续调整或生成效果图吗？',
      toolCallsInCurrentResponse: 0,
      hasSkillAskUserTool: true,
      isSkillClarificationEligible: true,
      hasUnfinishedTaskReference: false,
      alreadySteered: false
    })

    assert.equal(decision.kind, 'none')
  })

  test('does not steer when skill_ask_user is unavailable', () => {
    const decision = evaluateSkillClarificationGuard({
      assistantText: hfpClarificationText,
      toolCallsInCurrentResponse: 0,
      hasSkillAskUserTool: false,
      isSkillClarificationEligible: true,
      hasUnfinishedTaskReference: true,
      alreadySteered: false
    })

    assert.equal(decision.kind, 'none')
  })

  test('checkpoints when the steered clarification still asks in plain text', () => {
    const decision = evaluateSkillClarificationGuard({
      assistantText: '我需要你补充主推产品、门店面积和核心目标后再继续。',
      toolCallsInCurrentResponse: 0,
      hasSkillAskUserTool: true,
      isSkillClarificationEligible: true,
      hasUnfinishedTaskReference: true,
      alreadySteered: true
    })

    assert.equal(decision.kind, 'checkpoint')
  })

  test('does not steer conversational answers when this user turn is not skill-eligible', () => {
    const answer = [
      '我会从一个能把球轻轻传回给你的问题开始：',
      '',
      '1. “我”到底是谁？',
      '2. 如果今天只谈一件事，什么问题最值得停下来？',
      '',
      '这不是需要补充信息才能推进的任务，只是一个开放对话邀请。'
    ].join('\n')
    const decision = evaluateSkillClarificationGuard({
      assistantText: answer,
      toolCallsInCurrentResponse: 0,
      hasSkillAskUserTool: true,
      isSkillClarificationEligible: false,
      hasUnfinishedTaskReference: true,
      alreadySteered: false
    })

    assert.equal(decision.kind, 'none')
  })

  test('does not checkpoint negated clarification language after a steer', () => {
    const decision = evaluateSkillClarificationGuard({
      assistantText:
        '不是需要补充信息才能继续；我已经给了两个切入口：1. 我是谁？2. 今天的问题是什么？',
      toolCallsInCurrentResponse: 0,
      hasSkillAskUserTool: true,
      isSkillClarificationEligible: true,
      hasUnfinishedTaskReference: true,
      alreadySteered: true
    })

    assert.equal(decision.kind, 'none')
  })

  test('direct-answer task type is auxiliary insurance against skill clarification steering', () => {
    const decision = evaluateSkillClarificationGuard({
      assistantText: hfpClarificationText,
      toolCallsInCurrentResponse: 0,
      hasSkillAskUserTool: true,
      isSkillClarificationEligible: true,
      hasUnfinishedTaskReference: true,
      alreadySteered: false,
      taskType: 'direct_answer'
    })

    assert.equal(decision.kind, 'none')
  })

  test('checkpoint message preserves model text and does not claim the card failed to open', () => {
    const original = '我需要你补充主推产品、门店面积和核心目标后再继续。'
    const message = buildSkillClarificationCheckpointMessage(original)

    assert.match(message, /主推产品、门店面积和核心目标/)
    assert.doesNotMatch(message, /未能打开反问卡/)
    assert.doesNotMatch(message, /我需要你补充“/)
  })

  test('runtime steers skill clarification before emitting the plain question list', async () => {
    let sawSteerReminder = false
    const scripted = new ScriptedAgentRunner({}, [
      {
        turnIndex: 0,
        response: hfpClarificationText
      },
      {
        turnIndex: 1,
        response: '我已改用反问卡。',
        assertions: ({ messages }) => {
          const input = messages.find(
            (message) =>
              typeof message === 'object' &&
              message !== null &&
              (message as { turnIndex?: unknown }).turnIndex === 1 &&
              Object.prototype.hasOwnProperty.call(message, 'input')
          )
          sawSteerReminder = /单个问题调用 skill_ask_user；多个问题调用 ask_user_questions/.test(
            JSON.stringify(input)
          )
        }
      }
    ])
    const { runtime, outputs } = createRuntime({
      ...scripted.deps,
      loadAIConfig: () => ({
        ok: true,
        reason: 'present',
        config: {
          ...fakeConfig,
          provider: 'openai-compatible',
          baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
          model: 'mimo-v2.5',
          agentProtocol: 'anthropic'
        }
      }),
      listToolDefinitions: () => [createSkillAskUserToolDefinition()]
    })
    runtime.newSession('butler::scope-skill-clarification-steer', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-skill-clarification-steer',
      '继续 hfp-space-design 方案，需要补充信息就问我',
      'run-skill-clarification-steer',
      {
        publicSessionId: 'scope-skill-clarification-steer',
        taskId: 'task-skill-clarification-steer',
        continuationIntent: { taskId: 'task-skill-clarification-steer' }
      }
    )

    assert.equal(result.success, true)
    assert.equal(result.terminalReason, 'done')
    assert.equal(sawSteerReminder, true)
    assert.equal(
      outputs.some((event) => event.chunk.includes('最能提升方案质量')),
      false
    )
    assert.ok(outputs.some((event) => event.chunk.includes('我已改用反问卡。')))
  })
})
