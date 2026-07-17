import assert from 'node:assert/strict'
import test from 'node:test'

import { assembleAgentSdkTurnInput } from '../main/modules/agent-control/runtime-core/agent-sdk-turn-input-assembly'
import { formatUserProfilePrompt } from '../main/modules/agent-control/user-profile-prompt'
import type { AgentSdkSkillCatalogSnapshotEntry } from '../main/modules/agent-control/runtime-core/agent-sdk-types'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import type { RequestedCapabilityConflict } from '../main/modules/agent-control/domain-adapters/capability-resolver'

function toolDefinition(
  name: string,
  groupId: ToolDefinition['groupId'],
): ToolDefinition {
  return {
    name,
    groupId,
    domain: groupId.startsWith('browser_') ? 'browser' : 'general_research',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: groupId.startsWith('browser_') ? 'browser_interactive' : 'default',
    supportsTextBridge: true,
    projectionHint: null,
    description: `${name} test tool`,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

function assemble(
  toolDefinitions: ToolDefinition[],
  options: {
    useTextToolBridge?: boolean
    skillCatalogSnapshot?: AgentSdkSkillCatalogSnapshotEntry[]
    requestedCapabilityConflicts?: RequestedCapabilityConflict[]
    systemPrompt?: string
  } = {},
) {
  return assembleAgentSdkTurnInput({
    host: {
      toolExecutor: {
        buildSdkTool: (definition: ToolDefinition) => ({ name: definition.name }),
      },
    } as never,
    session: { systemPrompt: options.systemPrompt ?? 'Ready system prompt' } as never,
    sessionId: 'scope-turn-input-assembly',
    runId: 'run-turn-input-assembly',
    providerContent: '请完成本轮任务',
    useTextToolBridge: options.useTextToolBridge === true,
    toolDefinitions,
    toolBridgeRuntimeContext: {} as never,
    hasVeaPipelineTool: false,
    hasMapAmbiguityQuestionTools: false,
    skillContextInstruction: '',
    documentTargetGuard: null,
    requiresLocalDocumentExcerpt: false,
    preferCurrentDocumentRead: false,
    capabilities: {} as never,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    skillCatalogSnapshot: options.skillCatalogSnapshot ?? [],
    requestedCapabilityConflicts: options.requestedCapabilityConflicts ?? [],
    emitOutput: () => undefined,
    finalizeEarlyReturn: async () => ({} as never),
  })
}

test('saved response style is moved to the final instruction block exactly once', () => {
  const profilePrompt = formatUserProfilePrompt({
    communicationStyle: 'friendly',
    preferencesJson: { longTermPreferences: '风趣幽默，四川辣妹' },
  })
  const assembled = assemble([], {
    systemPrompt: `Ready system prompt\n\n${profilePrompt}\n\nLATE_SYSTEM_RULE`,
  })

  assert.equal(
    (assembled.instructions.match(/ready:user-response-style:v1:start/g) || []).length,
    1,
  )
  assert.match(assembled.instructions, /把“四川辣妹”这类地域或人物气质标签理解为表达风格/)
  assert.match(assembled.instructions, /LATE_SYSTEM_RULE/)
  assert.ok(
    assembled.instructions.trimEnd().endsWith('<!-- ready:user-response-style:v1:end -->'),
    '风格执行合同必须是 provider instructions 的最后一块',
  )
})

test('turn instructions stay unchanged when the user has no saved response style', () => {
  const assembled = assemble([], {
    systemPrompt: formatUserProfilePrompt({ preferredLanguage: 'zh' }),
  })
  assert.doesNotMatch(assembled.instructions, /ready:user-response-style/)
  assert.ok(!assembled.instructions.trimEnd().endsWith('ready:user-response-style:v1:end -->'))
})

test('browser discipline is absent without a final browser group and present exactly once with both browser groups', () => {
  const withoutBrowser = assemble([
    toolDefinition('web_search', 'general_research'),
  ])
  assert.equal((withoutBrowser.instructions.match(/# 浏览器交互纪律/g) || []).length, 0)

  const withBrowser = assemble([
    toolDefinition('browser_navigate', 'browser_interaction'),
    toolDefinition('browser_collect', 'browser_content_tasks'),
    toolDefinition('browser_collect', 'browser_content_tasks'),
    toolDefinition('browser_eval', 'browser_interaction'),
  ])
  assert.equal((withBrowser.instructions.match(/# 浏览器交互纪律/g) || []).length, 1)
  assert.match(withBrowser.instructions, /本轮可用 browser_collect/)
  assert.match(withBrowser.instructions, /本轮已开放列出的 Browser Power 工具/)
  assert.match(withBrowser.instructions, /browser_download/)
  assert.match(withBrowser.instructions, /browser_download/)
})

test('tool availability follows the final tool definitions even when the text bridge exposes no SDK tools', () => {
  const assembled = assemble(
    [toolDefinition('web_search', 'general_research')],
    { useTextToolBridge: true },
  )
  assert.equal(assembled.sdkTools.length, 0)
  assert.match(assembled.instructions, /本轮可用工具已经按 Ready 的策略过滤/)
  assert.doesNotMatch(assembled.instructions, /本轮没有开放工具/)
})

test('skill catalog stays in per-turn instructions and never enters persistent next input', () => {
  const assembled = assemble(
    [toolDefinition('use_skill', 'skill_activation')],
    { skillCatalogSnapshot: [{
      id: 'reference-writing',
      name: 'Reference Writing',
      description: '学习参考材料后独立创作',
    }] },
  )
  assert.match(assembled.instructions, /ready:system-reminder:skill-catalog/)
  assert.match(assembled.instructions, /@\[reference-writing\]/)
  assert.doesNotMatch(JSON.stringify(assembled.nextInput), /ready:system-reminder:skill-catalog/)
  assert.doesNotMatch(JSON.stringify(assembled.nextInput), /reference-writing/)
})

test('skill catalog is not advertised when the final tool surface cannot activate a skill', () => {
  const assembled = assemble(
    [],
    { skillCatalogSnapshot: [{
      id: 'reference-writing',
      name: 'Reference Writing',
      description: '学习参考材料后独立创作',
    }] },
  )
  assert.doesNotMatch(assembled.instructions, /ready:system-reminder:skill-catalog/)
  assert.doesNotMatch(assembled.instructions, /use_skill/)
})

test('requested capability conflicts are injected per turn and never persisted in next input', () => {
  const assembled = assemble([], {
    requestedCapabilityConflicts: [{
      groupId: 'browser_interaction',
      label: '浏览器交互',
      reason: 'provider_disabled_tools',
    }],
  })

  assert.match(assembled.instructions, /ready:system-reminder:tool-capability-conflict/)
  assert.match(assembled.instructions, /当前模型配置关闭了工具调用/)
  assert.match(assembled.instructions, /不得声称“已收到授权”/)
  assert.doesNotMatch(
    JSON.stringify(assembled.nextInput),
    /ready:system-reminder:tool-capability-conflict/,
  )
})
