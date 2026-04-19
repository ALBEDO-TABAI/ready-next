import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import { resolvePolicyConflicts } from '../main/modules/agent-control/policy-arbitration'
import type { ExecutionIntentContext } from '../main/modules/agent-control/execution-intent-resolver'
import type { ToolPolicy } from '../main/modules/agent-control/execution-tool-config'

// Pure-module tests for the policy arbitration layer. The full
// run-capability-controller integration tests are blocked from running under
// `tsx --test` because the tool-registry path transitively imports `electron`,
// which cannot be resolved by the Node ESM loader. The arbitration logic itself
// is pure and lives in `policy-arbitration.ts`, so we exercise it directly.

function buildIntent(userText: string, overrides: Partial<ExecutionIntentContext> = {}): ExecutionIntentContext {
  const requestEnvelope = buildRequestEnvelope({ userText })
  return {
    requestEnvelope,
    intentClassification: classifyIntent(requestEnvelope),
    contextualUserInput: userText,
    userInstructionText: userText,
    hasDocumentEnvironment: true,
    hasWidgetTargetContext: true,
    explicitWidgetCreateIntent: false,
    documentWidgetTaskKind: 'update',
    documentWidgetProfile: null,
    ...overrides,
  }
}

function buildToolPolicy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    forceDocumentTool: false,
    forceDesignTool: false,
    preferredDesignTool: null,
    allowMultipleDesignArtifacts: false,
    preferSectionRewrite: false,
    preferFormatOnly: false,
    documentWidgetTaskKind: null,
    allowBrowserTools: false,
    allowDocumentTools: true,
    preferredSkillToolNames: null,
    ...overrides,
  } as ToolPolicy
}

test('arbitration flags forceDocumentTool × browser_workflow as a conflict and demotes to free_tool_loop', () => {
  const result = resolvePolicyConflicts({
    toolPolicy: buildToolPolicy({ forceDocumentTool: true }),
    browserDecisionMode: 'browser_workflow',
    executionIntentContext: buildIntent('让这张信息卡下方留白少一点'),
  })

  assert.deepEqual(result.conflicts, ['force_document_x_browser_workflow'])
  assert.equal(result.demotedBrowserDecisionMode, 'free_tool_loop')
})

test('arbitration flags widget-update × allowBrowserTools=true as a conflict', () => {
  const result = resolvePolicyConflicts({
    toolPolicy: buildToolPolicy({ allowBrowserTools: true }),
    browserDecisionMode: 'browser_upload_workflow',
    executionIntentContext: buildIntent('更新一下当前信息卡的配色', {
      documentWidgetTaskKind: 'update',
    }),
  })

  assert.ok(result.conflicts.includes('widget_task_x_browser_tools_allowed'))
  assert.equal(result.demotedBrowserDecisionMode, 'free_tool_loop')
})

test('arbitration keeps browser_workflow for explicit widget-create intent', () => {
  const result = resolvePolicyConflicts({
    toolPolicy: buildToolPolicy({ forceDocumentTool: true, allowBrowserTools: true }),
    browserDecisionMode: 'browser_workflow',
    executionIntentContext: buildIntent('帮我新建一张信息卡，展示这个网页的关键字段', {
      explicitWidgetCreateIntent: true,
      documentWidgetTaskKind: 'create',
      hasWidgetTargetContext: false,
    }),
  })

  assert.deepEqual(result.conflicts, [])
  assert.equal(result.demotedBrowserDecisionMode, null)
})

test('arbitration is a no-op when there is no conflict (free_tool_loop + inspect)', () => {
  const result = resolvePolicyConflicts({
    toolPolicy: buildToolPolicy({ allowBrowserTools: false }),
    browserDecisionMode: 'free_tool_loop',
    executionIntentContext: buildIntent('帮我检查一下这张信息卡里的 props', {
      documentWidgetTaskKind: 'inspect',
    }),
  })

  assert.deepEqual(result.conflicts, [])
  assert.equal(result.demotedBrowserDecisionMode, null)
})

test('arbitration also detects late browser_workflow flips during a widget-update', () => {
  const intent = buildIntent('把这张信息卡的标题字号调大一点', {
    documentWidgetTaskKind: 'update',
  })

  const initial = resolvePolicyConflicts({
    toolPolicy: buildToolPolicy(),
    browserDecisionMode: 'free_tool_loop',
    executionIntentContext: intent,
  })
  assert.deepEqual(initial.conflicts, [])

  const reconciled = resolvePolicyConflicts({
    toolPolicy: buildToolPolicy({ forceDocumentTool: true, allowBrowserTools: true }),
    browserDecisionMode: 'browser_workflow',
    executionIntentContext: intent,
  })
  assert.ok(reconciled.conflicts.length > 0)
  assert.equal(reconciled.demotedBrowserDecisionMode, 'free_tool_loop')
})
