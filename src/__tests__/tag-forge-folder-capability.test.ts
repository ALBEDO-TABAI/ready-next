import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRequestEnvelope,
  envelopeHasLocalDocumentResource,
  trustedFolderReferencesFromMessageMeta,
} from '../main/modules/agent-control/contracts/request-envelope'
import { hasLocalDocumentResource } from '../main/modules/agent-control/runtime-core/agent-sdk-execution-utils'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { getToolResourceTag } from '../main/modules/agent-control/tools-runtime/tool-parallelism-policy'
import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import { executeToolCall, toStructuredToolResult, type ToolContext } from '../main/modules/tools/tool-executor'
import { mapReadyToolOutput } from '../main/modules/agent-control/codex-runtime/codex-tool-output-mapper'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { buildTextToolBridgePrompt, buildTextToolResultMessage } from '../main/modules/claude-bridge/tool-bridge'
import { completeTagForgeHostReview } from '../main/modules/tag-forge/tag-forge-host-review'
import { getFileManagementAnthropicTools, getFileManagementOpenAITools } from '../main/modules/tools/file-management-tools'
import {
  resolveReferencedFilePoolAttachments,
  serializePersistedAttachments,
} from '../renderer/modules/agent/messageComposer'
import type { ChatAttachment } from '../renderer/modules/agent/types'
import type { CapabilityGroupId } from '../shared/ai-capability-groups'
import type { ToolDomain } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const TAG_FORGE_TOOL_NAMES = [
  'tag_forge_prepare_batch',
  'tag_forge_apply_batch',
] as const

const EXPECTED_DOMAIN_BY_GROUP: Partial<Record<CapabilityGroupId, ToolDomain>> = {
  browser_interaction: 'browser',
  browser_content_tasks: 'browser',
  document: 'document',
  file_management: 'file',
  rss: 'rss',
  calendar: 'calendar',
  skills: 'skill',
  memory: 'memory',
  session_recall: 'session',
  pet: 'pet',
  channel_feishu: 'feishu',
  general_research: 'general_research',
  image_generation: 'image_generation',
  map_planning: 'map',
  system_host: 'system',
  mcp: 'mcp',
  agent_interaction: 'agent_interaction',
  skill_install: 'skill_install',
  skill_activation: 'skill_activation',
  channel_outbound: 'channel',
  mcp_install: 'mcp_install',
  command_exec: 'command_exec',
}

const envelope = {
  rawUserText: '用 @[tag-forge] 给 @[工作内容] 打标',
  pureUserText: '用 @[tag-forge] 给 @[工作内容] 打标',
  primaryInstruction: '用 @[tag-forge] 给 @[工作内容] 打标',
  chunks: [],
  resources: [{
    id: 'folder',
    kind: 'folder_reference' as const,
    source: 'folder_reference' as const,
    name: '工作内容',
    path: '/tmp/工作内容',
    text: '',
    summary: null,
    order: 0,
    canRead: true,
    canWrite: false,
  }],
  referencedResources: [],
  environmentHints: { hasDocumentContext: false, hasWidgetTargetContext: false, hasAttachments: true },
  provenanceSummary: { countsBySource: {} as never, userControllableSourcesOnly: true },
}

test('a typed folder reference is a local document resource on both capability paths', () => {
  assert.equal(envelopeHasLocalDocumentResource(envelope), true)
  assert.equal(hasLocalDocumentResource('用 @[tag-forge] 给 @[工作内容] 打标', envelope), true)
})

test('a reused pool folder trusts only the folder mentioned in this turn', () => {
  const folder = (name: string, path: string): ChatAttachment => ({
    id: name,
    name,
    path,
    type: 'other',
    isDirectory: true,
    size: 0,
    ext: '',
    source: 'file',
  })
  const selected = folder('pool-folder', '/Users/test/Documents/project/pool-folder')
  const unrelated = folder('other-folder', '/Users/test/Documents/project/other-folder')
  const reused = resolveReferencedFilePoolAttachments('给 @[pool-folder] 里的文档打标', [selected, unrelated])
  assert.deepEqual(reused.map((attachment) => attachment.name), ['pool-folder'])

  const persisted = serializePersistedAttachments(reused)
  const trusted = trustedFolderReferencesFromMessageMeta({ attachments: persisted })
  const request = buildRequestEnvelope({
    userText: '给 @[pool-folder] 里的文档打标\n\n### 文件夹引用\n- 名称: pool-folder\n- 路径: /Users/test/Documents/project/pool-folder',
    trustedFolderReferences: trusted,
  })
  assert.deepEqual(request.resources.filter((resource) => resource.kind === 'folder_reference').map((resource) => resource.name), ['pool-folder'])
  assert.equal(trusted.some((reference) => reference.name === 'other-folder'), false)
})

test('Tag Forge routing declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'Tag Forge unified tool routing')
})

test('every model-facing Tag Forge tool is registered in the file domain as a serialized write', () => {
  for (const toolName of TAG_FORGE_TOOL_NAMES) {
    const definition = defaultToolRegistry.getToolDefinitionForExecution(toolName)
    assert.ok(definition, `${toolName} must be registered`)
    assert.equal(definition.groupId, 'file_management')
    assert.equal(definition.domain, 'file')
    assert.equal(definition.kind, 'write')
    assert.deepEqual(getToolResourceTag(toolName), { domain: 'file', accessMode: 'write' })
  }
})

test('single-file apply and review continuation are host-private and absent from the model registry', () => {
  assert.equal(defaultToolRegistry.getToolDefinitionForExecution('tag_forge_apply'), null)
  assert.equal(defaultToolRegistry.getToolDefinitionForExecution('tag_forge_review_batch'), null)
  assert.equal(getFileManagementAnthropicTools().some((tool) => tool.name === 'tag_forge_apply'), false)
  assert.equal(getFileManagementAnthropicTools().some((tool) => tool.name === 'tag_forge_review_batch'), false)
  assert.equal(getFileManagementOpenAITools().some((tool) => (tool.function as { name?: string })?.name === 'tag_forge_apply'), false)
  assert.equal(getFileManagementOpenAITools().some((tool) => (tool.function as { name?: string })?.name === 'tag_forge_review_batch'), false)
})

test('production Tag Forge schemas expose every nested apply field to native and text models', () => {
  const anthropic = getFileManagementAnthropicTools()
    .find((tool) => tool.name === 'tag_forge_apply_batch') as {
      input_schema?: Record<string, unknown>
    } | undefined
  const openai = getFileManagementOpenAITools()
    .find((tool) => (tool.function as { name?: string })?.name === 'tag_forge_apply_batch') as {
      function?: { parameters?: Record<string, unknown> }
    } | undefined

  for (const schema of [anthropic?.input_schema, openai?.function?.parameters]) {
    const properties = schema?.properties as Record<string, Record<string, unknown>>
    const itemSchema = properties.items.items as Record<string, unknown>
    const itemProperties = itemSchema.properties as Record<string, Record<string, unknown>>
    const proposalSchema = itemProperties.proposals.items as Record<string, unknown>
    assert.deepEqual(itemSchema.required, ['itemId', 'expectedRevision', 'proposals'])
    assert.deepEqual(Object.keys(itemProperties), ['itemId', 'expectedRevision', 'proposals'])
    assert.deepEqual(proposalSchema.required, [
      'facet',
      'label',
      'evidenceCode',
      'evidenceExcerpt',
      'confidence',
    ])
    assert.deepEqual(Object.keys(proposalSchema.properties as Record<string, unknown>), [
      'facet',
      'label',
      'evidenceCode',
      'evidenceExcerpt',
      'confidence',
    ])
  }

  const prompt = buildTextToolBridgePrompt([openai as Record<string, unknown>])
  for (const field of ['itemId', 'expectedRevision', 'proposals', 'facet', 'label', 'evidenceCode', 'evidenceExcerpt', 'confidence']) {
    assert.match(prompt, new RegExp(`\\b${field}\\b`))
  }
})

test('every registered tool resolves to the executor domain owned by its capability group', () => {
  const mismatches = defaultToolRegistry.listToolDefinitions()
    .filter((definition) => EXPECTED_DOMAIN_BY_GROUP[definition.groupId] !== definition.domain)
    .map((definition) => ({
      name: definition.name,
      groupId: definition.groupId,
      expected: EXPECTED_DOMAIN_BY_GROUP[definition.groupId] ?? null,
      actual: definition.domain,
    }))

  assert.deepEqual(mismatches, [])
})

test('the unified executor sends Tag Forge batch preparation to the file handler', async () => {
  const output = await executeToolCall('tag_forge_prepare_batch', {
    rootPath: '/tmp/tag-forge-routing-contract',
  }, {
    invoker: 'model',
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    allowedToolNames: new Set(['tag_forge_prepare_batch']),
    sessionId: 'tag-forge-routing-contract',
  } as ToolContext)

  assert.doesNotMatch(output.text, /Unknown system tool/)
  assert.equal(output.shape, 'json')
  assert.ok(output.data)
  assert.doesNotMatch(output.text, /^\s*\{/)
})

test('the text bridge returns prepared documents and lexicon to the next model turn', () => {
  const message = buildTextToolResultMessage([{
    id: 'call-tag-forge-prepare',
    name: 'tag_forge_prepare_batch',
    result: createToolExecutionOutput('Tag Forge 批次已处理 1 份，剩余 1 份。', {
      shape: 'json',
      data: {
        ok: true,
        batchId: 'tfb-text-bridge',
        documents: [{ itemId: 'opaque-item', expectedRevision: 'revision-1', content: '# Claude 教程' }],
        lexicon: { active: { form: [{ label: '教程' }], domain: [{ label: 'AI工作流' }] } },
      },
    }),
  }])
  assert.match(message, /Tag Forge 批次已处理 1 份/)
  assert.match(message, /opaque-item/)
  assert.match(message, /revision-1/)
  assert.match(message, /Claude 教程/)
  assert.match(message, /AI工作流/)
})

test('Codex receives exact Tag Forge apply handles before the prepared document body', () => {
  const longBody = `# 调研\n\n${'正文证据。'.repeat(4_000)}`
  const structured = toStructuredToolResult('tag_forge_prepare_batch', JSON.stringify({
    ok: true,
    batchId: 'tfb-handle-first',
    remaining: 1,
    documents: [{
      itemId: 'tfi-exact-handle',
      file: '调研.md',
      expectedRevision: 'revision-exact',
      content: longBody,
    }],
  }))
  const mapped = mapReadyToolOutput(structured)
  const first = mapped.contentItems[0] as { type: 'inputText'; text: string }
  const full = mapped.contentItems[1] as { type: 'inputText'; text: string }

  assert.equal(first.type, 'inputText')
  assert.match(first.text, /Reuse each itemId and expectedRevision exactly/)
  assert.match(first.text, /tfi-exact-handle/)
  assert.match(first.text, /revision-exact/)
  assert.ok(first.text.length < 600)
  assert.doesNotMatch(first.text, /正文证据/)
  assert.match(full.text, /tfi-exact-handle/)
  assert.match(full.text, /正文证据/)
})

test('the host owns the complete Tag Forge review round trip', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const effectPhases: string[] = []
  let questions=0
  const completedResult = {
    ok: true,
    done: true,
    transactionConfirmed: { confirmed: true, source: 'tag_forge_readback', signal: 'tfb-host-review' },
  }
  const result = JSON.stringify({
    ok: true,
    batchId: 'tfb-host-review',
    reviewRequired: true,
    reviewQuestion: {
      questions: [{
        id: 'tag-forge-review-1',
        question: '采用哪些标签？',
        kind: 'multi_choice',
        options: ['浏览器技术', '都不采用'],
        required: false,
      }],
    },
  })
  const reviewed = await completeTagForgeHostReview(
    'tag_forge_apply_batch',
    result,
    {
      runId: 'run-host-review',
      sessionId: 'session-host-review',
      scopeId: 'scope-host-review',
      onToolEffectEnd: () => effectPhases.push('pause-for-review'),
      onToolEffectStart: () => effectPhases.push('resume-review-write'),
    },
    { marker: 'file-context' },
    {
      askUserQuestions: async () => {questions+=1;return createToolExecutionOutput('已回答', {
        shape: 'json',
        data: { cardId: 'auq-host-review' },
      })},
      executeFileTool: async (name, args) => {
        calls.push({ name, args })
        return JSON.stringify(completedResult)
      },
    },
  )

  assert.equal(reviewed, JSON.stringify(completedResult))
  assert.deepEqual(calls, [{
    name: 'tag_forge_review_batch',
    args: { batchId: 'tfb-host-review', confirmationCardId: 'auq-host-review' },
  }])
  assert.deepEqual(effectPhases, ['pause-for-review', 'resume-review-write'])
  const deferred=await completeTagForgeHostReview('tag_forge_prepare_batch',result,{runId:'run-host-review',sessionId:'session-host-review',scopeId:'scope-host-review'},{marker:'file-context'},{askUserQuestions:async()=>{questions+=1;return createToolExecutionOutput('unexpected')},executeFileTool:async()=>JSON.stringify({ok:true})})
  assert.equal(deferred,result)
  assert.equal(questions,1)
})

test('a failed review ask can retry in the same run before any card exists', async () => {
  const result = JSON.stringify({
    ok: true,
    batchId: 'tfb-host-review-retry',
    reviewRequired: true,
    reviewQuestion: {
      questions: [{
        id: 'tag-forge-review-retry-1',
        question: '采用哪些标签？',
        kind: 'multi_choice',
        options: ['浏览器技术', '都不采用'],
        required: false,
      }],
    },
  })
  let questions = 0
  const deps = {
    askUserQuestions: async () => {
      questions += 1
      return createToolExecutionOutput('反问结果', {
        shape: 'json',
        data: questions === 1 ? {} : { cardId: 'auq-host-review-retry' },
      })
    },
    executeFileTool: async () => JSON.stringify({ ok: true, done: true }),
  }
  const context = { runId: 'run-host-review-retry', sessionId: 'session-host-review-retry', scopeId: 'scope-host-review-retry' }
  await assert.rejects(() => completeTagForgeHostReview('tag_forge_apply_batch', result, context, {}, deps), /returned no card id/)
  const retried = await completeTagForgeHostReview('tag_forge_apply_batch', result, context, {}, deps)
  assert.equal(retried, JSON.stringify({ ok: true, done: true }))
  assert.equal(questions, 2)
})

test('a created review card is reused when its first internal continuation fails', async () => {
  const result = JSON.stringify({
    ok: true,
    batchId: 'tfb-host-review-continuation-retry',
    reviewRequired: true,
    reviewQuestion: {
      questions: [{
        id: 'tag-forge-review-continuation-retry-1',
        question: '采用哪些标签？',
        kind: 'multi_choice',
        options: ['浏览器技术', '都不采用'],
        required: false,
      }],
    },
  })
  let questions = 0
  let reviews = 0
  const deps = {
    askUserQuestions: async () => {
      questions += 1
      return createToolExecutionOutput('已回答', {
        shape: 'json',
        data: { cardId: 'auq-host-review-continuation-retry' },
      })
    },
    executeFileTool: async () => {
      reviews += 1
      return JSON.stringify(reviews === 1
        ? { ok: false, errorKind: 'temporary_review_failure' }
        : { ok: true, done: true })
    },
  }
  const context = {
    runId: 'run-host-review-continuation-retry',
    sessionId: 'session-host-review-continuation-retry',
    scopeId: 'scope-host-review-continuation-retry',
  }
  const failed = await completeTagForgeHostReview('tag_forge_apply_batch', result, context, {}, deps)
  assert.equal(failed, JSON.stringify({ ok: false, errorKind: 'temporary_review_failure' }))
  const retried = await completeTagForgeHostReview('tag_forge_apply_batch', result, context, {}, deps)
  assert.equal(retried, JSON.stringify({ ok: true, done: true }))
  assert.equal(questions, 1)
  assert.equal(reviews, 2)
})

test('the host never asks a second review card for a changed review fingerprint', async () => {
  const first = JSON.stringify({
    ok: true,
    batchId: 'tfb-host-fingerprint',
    reviewRequired: true,
    reviewQuestion: { questions: [{ id: 'review-a', question: '采用哪些标签？', kind: 'multi_choice', options: ['标签甲'], required: false }] },
  })
  const changed = JSON.stringify({
    ok: true,
    batchId: 'tfb-host-fingerprint',
    reviewRequired: true,
    reviewQuestion: { questions: [{ id: 'review-b', question: '采用哪些标签？', kind: 'multi_choice', options: ['标签乙'], required: false }] },
  })
  let questions = 0
  let reviews = 0
  const deps = {
    askUserQuestions: async () => {
      questions += 1
      return createToolExecutionOutput('已回答', { shape: 'json', data: { cardId: 'auq-host-fingerprint' } })
    },
    executeFileTool: async () => {
      reviews += 1
      return JSON.stringify({ ok: false, errorKind: 'temporary_review_failure' })
    },
  }
  const context = { runId: 'run-host-fingerprint', sessionId: 'session-host-fingerprint', scopeId: 'scope-host-fingerprint' }
  await completeTagForgeHostReview('tag_forge_apply_batch', first, context, {}, deps)
  const deferred = await completeTagForgeHostReview('tag_forge_prepare_batch', changed, context, {}, deps)
  assert.equal(deferred, changed)
  assert.equal(questions, 1)
  assert.equal(reviews, 1)
})
