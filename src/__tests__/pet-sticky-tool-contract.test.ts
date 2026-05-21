import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  buildExecutionToolState,
  resolveExecutionIntentContext,
} from '../main/modules/agent-control/execution-intent-resolver'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('pet sticky note requests classify into the pet domain', () => {
  const envelope = buildRequestEnvelope({
    userText: '帮我把“下午三点前检查发布清单”贴到猫猫便利贴上',
  })
  const classification = classifyIntent(envelope)

  assert.equal(classification.primaryDomain, 'pet')
  assert.equal(classification.mentionedDomains.includes('pet' as never), true)
  assert.equal(classification.confidence, 'high')
})

test('pet sticky note tool is registered and gated by pet intent', () => {
  const definition = defaultToolRegistry.getToolDefinitionForExecution('pet_show_sticky_note')

  assert.ok(definition)
  assert.equal(definition.domain, 'pet')
  assert.equal(definition.groupId, 'pet')
  assert.equal(definition.kind, 'write')
  assert.match(definition.description, /整理或生成内容后再贴/)
  assert.doesNotMatch(definition.description, /不要自己编/)

  const genericTools = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    contextualUserInput: '你好',
    userInstructionText: '你好',
    intentClassification: classifyIntent(buildRequestEnvelope({ userText: '你好' })),
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'direct_answer',
  })
  const petTools = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    contextualUserInput: '把这个提醒贴到宠物气泡上：等构建完成后截图确认',
    userInstructionText: '把这个提醒贴到宠物气泡上：等构建完成后截图确认',
    intentClassification: classifyIntent(buildRequestEnvelope({ userText: '把这个提醒贴到宠物气泡上：等构建完成后截图确认' })),
    hasDocumentEnvironment: false,
    hasWidgetTargetContext: false,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: null,
    documentWidgetProfile: null,
    browserDecisionMode: 'direct_answer',
  })

  assert.equal(genericTools.visibilityPlan.visibleCapabilityGroupIds.includes('pet' as never), false)
  assert.equal(petTools.visibilityPlan.visibleCapabilityGroupIds.includes('pet' as never), true)
})

test('pet sticky follow-up keeps pet tools visible and suppresses document tools', () => {
  const requestEnvelope = buildRequestEnvelope({
    userText: '帮我随便找一些今日待办，然后贴起来',
  })
  const context = resolveExecutionIntentContext({
    requestEnvelope,
    previousInputs: ['能帮我把一些信息贴到猫猫的信息气泡上吗'],
  })
  const state = buildExecutionToolState({
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    contextualUserInput: context.contextualUserInput,
    userInstructionText: context.userInstructionText,
    intentClassification: context.intentClassification,
    hasDocumentEnvironment: context.hasDocumentEnvironment,
    hasWidgetTargetContext: context.hasWidgetTargetContext,
    explicitWidgetCreateIntent: context.explicitWidgetCreateIntent,
    documentWidgetTaskKind: context.documentWidgetTaskKind,
    documentWidgetProfile: context.documentWidgetProfile,
    browserDecisionMode: 'direct_answer',
  })

  assert.equal(context.intentClassification.primaryDomain, 'pet')
  assert.match(context.contextualUserInput, /猫猫的信息气泡/)
  assert.equal(state.visibilityPlan.visibleCapabilityGroupIds.includes('pet' as never), true)
  assert.equal(state.visibilityPlan.visibleCapabilityGroupIds.includes('document'), false)
})

test('pet sticky tool execution path uses the pet window manager, not document or browser tools', () => {
  const toolExecutor = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')
  const petTools = readWorkspaceFile('src/main/modules/tools/pet-tools.ts')
  const schemas = readWorkspaceFile('src/main/modules/tools/schemas/index.ts')

  assert.match(toolExecutor, /case 'pet':/)
  assert.match(petTools, /executePetTool/)
  assert.match(petTools, /pet_show_sticky_note/)
  assert.match(petTools, /getActivePetWindowManager/)
  assert.match(schemas, /PET_SCHEMAS/)
})
