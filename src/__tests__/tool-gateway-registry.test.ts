import assert from 'node:assert/strict'
import test from 'node:test'

import { ToolGateway } from '../main/modules/agent-control/tool-gateway'

test('tool gateway exposes formal capability groups and resolves grouped tools', () => {
  const gateway = new ToolGateway()

  const groups = gateway.listCapabilityGroups()
  const groupIds = groups.map((group) => group.id)
  assert.ok(groupIds.includes('browser_interaction'))
  assert.ok(groupIds.includes('browser_content_tasks'))
  assert.ok(groupIds.includes('system_host'))
  assert.ok(groupIds.includes('design_reserved'))

  const browserInteractionTools = gateway.collectToolNamesForGroups(['browser_interaction'])
  const browserContentTools = gateway.collectToolNamesForGroups(['browser_content_tasks'])
  const systemTools = gateway.collectToolNamesForGroups(['system_host'])
  const skillTools = gateway.collectToolNamesForGroups(['skills'])
  const skillsGroup = gateway.getCapabilityGroup('skills')
  const systemOpenAISchemas = gateway.getToolSchemasForGroup('system_host', 'openai')

  assert.ok(browserInteractionTools.includes('browser_navigate'))
  assert.ok(browserInteractionTools.includes('browser_click'))
  assert.ok(!browserInteractionTools.includes('browser_extract_structured'))

  assert.ok(browserContentTools.includes('browser_extract_structured'))
  assert.ok(browserContentTools.includes('browser_scroll_collect'))
  assert.ok(!browserContentTools.includes('browser_click'))

  assert.ok(systemTools.includes('system_run_embedded_python'))
  assert.ok(systemTools.includes('system_run_openclaw'))
  assert.ok(skillTools.includes('skill_get_state'))
  assert.ok(skillTools.includes('skill_video_expert_pipeline'))
  assert.equal(skillsGroup?.hasDynamicSource, true)
  assert.ok(systemOpenAISchemas.some((tool) => (tool.function as { name?: string } | undefined)?.name === 'system_run_openclaw'))
})

test('tool gateway does not expose empty fallback schemas when a group provider fails to load', () => {
  const gateway = new ToolGateway({
    __testGroupProviders: {
      system_host: {
        staticToolNames: ['system_run_openclaw'],
        getOpenAITools: () => {
          throw new Error('broken provider')
        },
      },
    },
  })

  const systemOpenAISchemas = gateway.getToolSchemasForGroup('system_host', 'openai')

  assert.deepEqual(systemOpenAISchemas, [])
  assert.match(gateway.getLastSchemaResolutionError('system_host', 'openai') || '', /broken provider/)
})
