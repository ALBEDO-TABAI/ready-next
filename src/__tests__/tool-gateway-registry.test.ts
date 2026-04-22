import assert from 'node:assert/strict'
import test from 'node:test'

import { collectAllowedToolNames } from '../main/modules/agent-control/execution-tool-config'
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
  const browserNavigate = gateway.getToolDefinition('browser_navigate')
  const documentSave = gateway.getToolDefinition('document_save_tab')
  const documentInsertWidget = gateway.getToolDefinition('document_insert_widget')
  const documentUpdateWidget = gateway.getToolDefinition('document_update_widget')
  const documentRemoveWidget = gateway.getToolDefinition('document_remove_widget')
  const documentListWidgets = gateway.getToolDefinition('document_list_widgets')
  const skillPipeline = gateway.getToolDefinition('skill_video_expert_pipeline')

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
  assert.equal(browserNavigate?.domain, 'browser')
  assert.equal(browserNavigate?.kind, 'interactive')
  assert.equal(browserNavigate?.concurrency, 'serialized')
  assert.equal(browserNavigate?.interruptBehavior, 'abort_signal')
  assert.equal(browserNavigate?.timeoutProfile, 'browser_interactive')
  assert.equal(browserNavigate?.supportsTextBridge, false)
  assert.equal(browserNavigate?.projectionHint, null)
  assert.match(browserNavigate?.description || '', /导航/)
  assert.equal(browserNavigate?.schema?.type, 'object')
  assert.equal(browserNavigate?.resultShape, 'text')
  assert.equal(documentSave?.domain, 'document')
  assert.equal(documentSave?.kind, 'write')
  assert.equal(documentSave?.timeoutProfile, 'document_write')
  assert.equal(documentSave?.supportsTextBridge, true)
  assert.deepEqual(documentSave?.projectionHint, { mutating: true, emitsProjectionPatch: true })
  assert.equal(documentSave?.resultShape, 'projection_patch')
  assert.match(documentSave?.description || '', /保存/)
  assert.equal(documentSave?.schema?.type, 'object')
  assert.equal(documentInsertWidget?.resultShape, 'projection_patch')
  assert.deepEqual(documentInsertWidget?.projectionHint, { mutating: true, emitsProjectionPatch: true })
  assert.equal(documentUpdateWidget?.resultShape, 'projection_patch')
  assert.deepEqual(documentUpdateWidget?.projectionHint, { mutating: true, emitsProjectionPatch: true })
  assert.equal(
    typeof (documentUpdateWidget?.schema?.properties as Record<string, unknown> | undefined)?.componentSpecPatch,
    'object',
  )
  assert.equal(documentRemoveWidget?.resultShape, 'projection_patch')
  assert.deepEqual(documentRemoveWidget?.projectionHint, { mutating: true, emitsProjectionPatch: true })
  assert.equal(documentListWidgets?.resultShape, 'text')
  assert.equal(documentListWidgets?.projectionHint, null)
  assert.equal(skillPipeline?.domain, 'skill')
  assert.equal(skillPipeline?.interruptBehavior, 'host_managed')
  assert.equal(skillPipeline?.timeoutProfile, 'skill')
  assert.equal(skillPipeline?.supportsTextBridge, true)
  assert.deepEqual(skillPipeline?.projectionHint, { emitsProjectionPatch: true })
  assert.equal(skillPipeline?.resultShape, 'projection_patch')
  assert.match(skillPipeline?.description || '', /workflow|启动|fallback schema/)
  assert.equal(skillPipeline?.schema?.type, 'object')
  assert.ok(gateway.listToolDefinitions().some((tool) => tool.name === 'session_search' && tool.domain === 'session'))
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

test('browser tool schemas stay available after the browser executor module loads first', async () => {
  await import('../main/modules/tools/browser-tools')

  const gateway = new ToolGateway()
  const browserOpenAISchemas = gateway.getToolSchemasForGroup('browser_interaction', 'openai')
  const browserToolNames = browserOpenAISchemas
    .map((tool) => (tool.function as { name?: string } | undefined)?.name || '')
    .filter(Boolean)

  assert.ok(browserToolNames.includes('browser_search'))
  assert.ok(browserToolNames.includes('browser_read_page'))
  assert.equal(gateway.getLastSchemaResolutionError('browser_interaction', 'openai'), null)
})

test('tool gateway reports grouped schema diagnostics and static fallback usage', () => {
  const gateway = new ToolGateway({
    __testGroupProviders: {
      skills: {
        staticToolNames: ['skill_get_state'],
        hasDynamicSource: true,
        getOpenAIToolsDetailed: () => ({
          tools: [{
            type: 'function',
            function: {
              name: 'skill_get_state',
              description: 'fallback',
              parameters: {
                type: 'object',
                properties: {},
                required: [],
              },
            },
          }],
          error: 'runtime unavailable',
          usedStaticFallback: true,
        }),
      },
    },
  })

  const resolution = gateway.getToolSchemaResolutionForGroups(['skills'], 'openai')

  assert.equal(resolution.groupResolutions[0]?.toolCount, 1)
  assert.equal(resolution.groupResolutions[0]?.usedStaticFallback, true)
  assert.match(resolution.groupResolutions[0]?.schemaError || '', /runtime unavailable/)
  assert.match(gateway.getLastSchemaResolutionError('skills', 'openai') || '', /runtime unavailable/)
})

test('collectAllowedToolNames keeps browser tools when browser groups are visible', () => {
  const allowedToolNames = collectAllowedToolNames({
    forceDocumentTool: false,
    allowDocumentTools: true,
    forceDesignTool: false,
    preferredDesignTool: null,
    primaryDesignInstruction: null,
    allowMultipleDesignArtifacts: false,
    preferSectionRewrite: false,
    preferFormatOnly: false,
    allowBrowserTools: true,
    preferredSkillToolNames: null,
    visibleCapabilityGroupIds: ['browser_interaction', 'browser_content_tasks', 'memory', 'session_recall'],
    hostOnlyCapabilityGroupIds: [],
    capabilityReasons: {},
  })

  assert.ok(allowedToolNames.includes('browser_search'))
  assert.ok(allowedToolNames.includes('browser_read_page'))
  assert.ok(allowedToolNames.includes('browser_extract_structured'))
})
