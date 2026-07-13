import assert from 'node:assert/strict'
import test from 'node:test'

import { envelopeHasLocalDocumentResource } from '../main/modules/agent-control/contracts/request-envelope'
import { hasLocalDocumentResource } from '../main/modules/agent-control/runtime-core/agent-sdk-execution-utils'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import { getToolResourceTag } from '../main/modules/agent-control/tools-runtime/tool-parallelism-policy'
import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import { executeToolCall, type ToolContext } from '../main/modules/tools/tool-executor'
import type { CapabilityGroupId } from '../shared/ai-capability-groups'
import type { ToolDomain } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const TAG_FORGE_TOOL_NAMES = [
  'tag_forge_apply',
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

test('Tag Forge routing declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'Tag Forge unified tool routing')
})

test('every Tag Forge tool is registered in the file domain as a serialized write', () => {
  for (const toolName of TAG_FORGE_TOOL_NAMES) {
    const definition = defaultToolRegistry.getToolDefinitionForExecution(toolName)
    assert.ok(definition, `${toolName} must be registered`)
    assert.equal(definition.groupId, 'file_management')
    assert.equal(definition.domain, 'file')
    assert.equal(definition.kind, 'write')
    assert.deepEqual(getToolResourceTag(toolName), { domain: 'file', accessMode: 'write' })
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
})
