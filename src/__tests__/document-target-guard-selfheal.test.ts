/**
 * W10 — @路径 目标文档守卫自愈合同（2026-07-11 dogfood 三连修）。
 *
 * 实锚：run req-1783746816981（terminal=blocked_tool_error）——技能收窄轮的工具面
 * 没有 document_open_tab，守卫的 openToolDefinition 在 turn-preparation 早绑为
 * undefined（先于地板兜底），mutation 前置检查抛 target_document_open_unavailable，
 * 模型被迫用 artifact 整文件覆写或 markdown 表格冒充信息卡。
 *
 * 合同：
 *   C1 守卫的开门/保存工具在绑定缺失时必须能从注册表自愈（模型不可见，免疫收窄）。
 *   C2 守卫指令与修复回合文案必须与"自动开存"现实一致，并携带 widget 硬指令。
 *   C3 文档指引 live 通道以"最终工具面含 document_insert_widget"为事实信号注入。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { AgentSdkToolExecutor } from '../main/modules/agent-control/runtime-core/agent-sdk-tool-executor'
import {
  buildDocumentTargetContinuationRepairInput,
  buildDocumentTargetInstruction,
} from '../main/modules/agent-control/runtime-core/agent-sdk-document-utils'
import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { buildDocumentSurfaceGuidance } from '../main/modules/agent-control/tool-policy/execution-tool-config'
import type { DocumentTargetGuard } from '../main/modules/agent-control/runtime-core/agent-sdk-types'

function guardFixture(): DocumentTargetGuard {
  return {
    targetName: '白痴_第二部第1章笔记.md',
    targetPath: '/tmp/白痴_第二部第1章笔记.md',
    opened: false,
    preserveExistingContent: true,
  } as DocumentTargetGuard
}

type GuardToolCall = { name: string; args: Record<string, unknown> }

/** 在 executeGuardDocumentTool 接缝打桩：只替换"执行"，自愈解析走真注册表。 */
function stubbedExecutor(calls: GuardToolCall[]): AgentSdkToolExecutor {
  const executor = new AgentSdkToolExecutor({} as never)
  ;(executor as unknown as Record<string, unknown>).executeGuardDocumentTool = async (
    definition: { name: string },
    args: Record<string, unknown>,
  ) => {
    calls.push({ name: definition.name, args })
    return createToolExecutionOutput('已打开文档标签。', { shape: 'json', data: { ok: true } })
  }
  return executor
}

test('自愈前提：注册表能为执行解析守卫的开门/保存工具', () => {
  assert.ok(defaultToolRegistry.getToolDefinitionForExecution('document_open_tab'))
  assert.ok(defaultToolRegistry.getToolDefinitionForExecution('document_save_tab'))
})

test('C1 开门自愈：面无 document_open_tab 时守卫从注册表解析并自动打开目标', async () => {
  const calls: GuardToolCall[] = []
  const executor = stubbedExecutor(calls)
  const guard = guardFixture()
  const blocked = await (executor as unknown as {
    ensureExplicitDocumentTargetOpened: (ctx: unknown) => Promise<unknown>
  }).ensureExplicitDocumentTargetOpened({ documentTargetGuard: guard })
  assert.equal(blocked, null, '不得再返回 target_document_open_unavailable')
  assert.equal(guard.opened, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'document_open_tab')
  assert.equal(calls[0].args.path, guard.targetPath)
  assert.equal(guard.openToolDefinition?.name, 'document_open_tab', '解析结果必须回写 guard 防重复解析')
})

test('C1 保存自愈：面无 document_save_tab 时守卫从注册表解析并自动保存', async () => {
  const calls: GuardToolCall[] = []
  const executor = stubbedExecutor(calls)
  const guard = guardFixture()
  const blocked = await (executor as unknown as {
    ensureExplicitDocumentTargetSaved: (ctx: unknown) => Promise<unknown>
  }).ensureExplicitDocumentTargetSaved({ documentTargetGuard: guard })
  assert.equal(blocked, null, '不得再返回 target_document_save_unavailable')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'document_save_tab')
  assert.equal(guard.saveToolDefinition?.name, 'document_save_tab')
})

test('C2 守卫指令与自动开存现实一致，不再叫模型自己 open_tab', () => {
  const text = buildDocumentTargetInstruction(guardFixture())
  assert.match(text, /自动打开/)
  assert.match(text, /自动保存/)
  assert.doesNotMatch(text, /先使用 document_open_tab/)
})

test('C2 守卫指令携带 widget 硬指令（信息卡→insert_widget，禁止冒充）', () => {
  const text = buildDocumentTargetInstruction(guardFixture())
  assert.match(text, /document_insert_widget/)
  assert.match(text, /禁止用 document_replace_text/)
  assert.match(text, /冒充/)
})

test('C2 修复回合引用地板必在的工具，不再索要可能缺席的整文写入器', () => {
  const text = buildDocumentTargetContinuationRepairInput(guardFixture())
  assert.match(text, /document_insert_widget/)
  assert.match(text, /document_replace_exact/)
  assert.match(text, /自动打开并保存/)
  assert.doesNotMatch(text, /必须调用 document_set_content/)
})

test('C3 live 文档指引以最终工具面为事实信号（含目录与家族基线）', () => {
  const withWidget = buildDocumentSurfaceGuidance({
    toolNames: new Set(['document_insert_widget', 'document_read_section']),
    userText: '在文档开头做一张信息卡让用户可以直观看完整篇文档的内容',
  })
  assert.match(withWidget, /必须[\s\S]*document_insert_widget/)
  assert.match(withWidget, /禁止[\s\S]*冒充卡片/)
  assert.match(withWidget, /OpenUI 文档组件规则/)
  assert.match(withWidget, /info_card/)

  const withoutWidgetTool = buildDocumentSurfaceGuidance({
    toolNames: new Set(['document_read_section', 'file_read_excerpt']),
    userText: '在文档开头做一张信息卡',
  })
  assert.equal(withoutWidgetTool, '')
})

test('C3b live 指引携带 componentSpec 字段结构（2026-07-11 dogfood 第六例：模型盲猜 props）', () => {
  const guidance = buildDocumentSurfaceGuidance({
    toolNames: new Set(['document_insert_widget']),
    userText: '读一遍文档，然后在开头做一张信息卡帮助用户快速获取文章信息',
  })
  assert.match(guidance, /componentSpec 字段结构/)
  assert.match(guidance, /info_card:/)
  assert.match(guidance, /facts/)
  assert.match(guidance, /facts\[\] = \{label!\(string\), value!\(string\)\}/)
  assert.match(guidance, /relationship_graph:/)
  assert.match(guidance, /速览.*facts|facts.*键值行/)
})

test('C3 source pin: live 前导词组装必须消费 buildDocumentSurfaceGuidance', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract (W10-F4): assembleAgentSdkTurnInput 的行为验证需要完整 SDK host（emitContextBill / skill runtime / reminder registry 均有环境副作用），无法在纯 Node 下驱动；接线本身以源级 pin 钉住，函数行为已由上一条真调用覆盖。
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/modules/agent-control/runtime-core/agent-sdk-turn-input-assembly.ts'),
    'utf8',
  )
  assert.ok(source.includes('buildDocumentSurfaceGuidance({'), 'assembly 必须调用 live 通道')
  assert.ok(
    source.includes('toolNames: new Set(toolDefinitions.map'),
    'live 通道的输入必须是本轮最终工具面'
  )
})
