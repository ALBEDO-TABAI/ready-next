import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterPreferredSkillAnthropicTools,
  filterPreferredSkillOpenAITools,
  isSkillToolName,
  mergeForceDocumentAllowedNames,
} from '../main/modules/agent-control/execution-tool-skill-filters'

// Pure-module contract tests for the skill tool filtering boundary. The full
// getPolicyOpenAIToolBundle pipeline is blocked from running under `tsx --test`
// because it transitively imports `electron` (via the tool registry). The
// filter primitives themselves live in the dedicated execution-tool-skill-filters
// module, so we exercise them directly with synthetic tool lists.

function openAITool(name: string): Record<string, unknown> {
  return { type: 'function', function: { name, description: '', parameters: {} } }
}

function anthropicTool(name: string): Record<string, unknown> {
  return { name, description: '', input_schema: { type: 'object' } }
}

test('isSkillToolName recognizes skill_ prefix and system_run_embedded_python', () => {
  assert.equal(isSkillToolName('skill_get_state'), true)
  assert.equal(isSkillToolName('skill_novel_writer_system_draft'), true)
  assert.equal(isSkillToolName('system_run_embedded_python'), true)
  assert.equal(isSkillToolName('document_update_widget'), false)
  assert.equal(isSkillToolName('browser_click'), false)
  assert.equal(isSkillToolName(''), false)
})

test('filterPreferredSkillOpenAITools keeps non-skill tools when preferred list is set', () => {
  const tools = [
    openAITool('browser_click'),
    openAITool('document_update_widget'),
    openAITool('memory_save'),
    openAITool('skill_get_state'),
    openAITool('skill_novel_writer_system_draft'),
    openAITool('skill_some_other_skill_action'),
    openAITool('system_run_embedded_python'),
  ]

  const filtered = filterPreferredSkillOpenAITools(tools, [
    'skill_get_state',
    'skill_novel_writer_system_draft',
    'system_run_embedded_python',
  ])

  const names = filtered.map((tool) => (tool.function as { name: string }).name)
  // Non-skill tools stay untouched
  assert.ok(names.includes('browser_click'))
  assert.ok(names.includes('document_update_widget'))
  assert.ok(names.includes('memory_save'))
  // Skill tools filtered by the allowlist
  assert.ok(names.includes('skill_get_state'))
  assert.ok(names.includes('skill_novel_writer_system_draft'))
  assert.ok(names.includes('system_run_embedded_python'))
  assert.ok(!names.includes('skill_some_other_skill_action'))
})

test('filterPreferredSkillAnthropicTools keeps non-skill tools when preferred list is set', () => {
  const tools = [
    anthropicTool('browser_click'),
    anthropicTool('document_update_widget'),
    anthropicTool('skill_get_state'),
    anthropicTool('skill_unrelated_skill_action'),
  ]

  const filtered = filterPreferredSkillAnthropicTools(tools, ['skill_get_state'])

  const names = filtered.map((tool) => tool.name as string)
  assert.ok(names.includes('browser_click'))
  assert.ok(names.includes('document_update_widget'))
  assert.ok(names.includes('skill_get_state'))
  assert.ok(!names.includes('skill_unrelated_skill_action'))
})

test('filterPreferredSkillOpenAITools is a pass-through when preferred list is empty', () => {
  const tools = [
    openAITool('browser_click'),
    openAITool('skill_any'),
    openAITool('document_x'),
  ]

  const filtered = filterPreferredSkillOpenAITools(tools, [])

  assert.equal(filtered.length, tools.length)
  assert.deepEqual(
    filtered.map((tool) => (tool.function as { name: string }).name),
    ['browser_click', 'skill_any', 'document_x'],
  )
})

test('filterPreferredSkillAnthropicTools is a pass-through when preferred list is empty', () => {
  const tools = [
    anthropicTool('browser_click'),
    anthropicTool('skill_any'),
  ]

  const filtered = filterPreferredSkillAnthropicTools(tools, [])

  assert.equal(filtered.length, 2)
})

test('mergeForceDocumentAllowedNames unions skill tools into the document allowlist', () => {
  const baseAllowed = new Set<string>([
    'document_open_tab',
    'document_update_widget',
    'document_save_tab',
  ])

  const merged = mergeForceDocumentAllowedNames(baseAllowed, [
    'skill_get_state',
    'skill_novel_writer_system_draft',
  ])

  assert.ok(merged.has('document_open_tab'))
  assert.ok(merged.has('document_update_widget'))
  assert.ok(merged.has('document_save_tab'))
  assert.ok(merged.has('skill_get_state'))
  assert.ok(merged.has('skill_novel_writer_system_draft'))
  // Original base set is untouched (no mutation)
  assert.ok(!baseAllowed.has('skill_get_state'))
})

test('mergeForceDocumentAllowedNames returns base set unchanged when preferred list is null/empty', () => {
  const baseAllowed = new Set<string>(['document_open_tab'])

  const mergedNull = mergeForceDocumentAllowedNames(baseAllowed, null)
  const mergedEmpty = mergeForceDocumentAllowedNames(baseAllowed, [])
  const mergedUndef = mergeForceDocumentAllowedNames(baseAllowed, undefined)

  // Identity (same reference) — no allocation when no merge needed
  assert.equal(mergedNull, baseAllowed)
  assert.equal(mergedEmpty, baseAllowed)
  assert.equal(mergedUndef, baseAllowed)
})

test('document + skill co-existence under forceDocumentTool semantics end-to-end', () => {
  // Simulate the full getPolicyOpenAIToolBundle pipeline steps that are pure:
  // 1. forceDocumentTool narrows tools to document whitelist ∪ preferredSkillTools
  // 2. preferredSkill filter only affects skill-prefix tools thereafter.
  const candidateTools = [
    openAITool('document_open_tab'),
    openAITool('document_update_widget'),
    openAITool('document_save_tab'),
    openAITool('document_insert_widget'),
    openAITool('browser_click'),
    openAITool('memory_save'),
    openAITool('skill_get_state'),
    openAITool('skill_novel_writer_system_draft'),
    openAITool('skill_some_other_skill'),
  ]

  const baseAllowed = new Set<string>([
    'document_open_tab',
    'document_switch_tab',
    'document_list_widgets',
    'document_update_widget',
    'document_save_tab',
  ])
  const preferredSkillToolNames = [
    'skill_get_state',
    'skill_submit_input',
    'skill_novel_writer_system_draft',
    'system_run_embedded_python',
  ]

  const allowedNames = mergeForceDocumentAllowedNames(baseAllowed, preferredSkillToolNames)
  let tools = candidateTools.filter((tool) => {
    const fn = (tool.function as { name: string }).name
    return allowedNames.has(fn)
  })
  tools = filterPreferredSkillOpenAITools(tools, preferredSkillToolNames)

  const names = tools.map((tool) => (tool.function as { name: string }).name)
  // Document whitelist preserved
  assert.ok(names.includes('document_open_tab'))
  assert.ok(names.includes('document_update_widget'))
  assert.ok(names.includes('document_save_tab'))
  // document_insert_widget not in update whitelist — stays filtered out
  assert.ok(!names.includes('document_insert_widget'))
  // Skill passthrough works under forceDocumentTool
  assert.ok(names.includes('skill_get_state'))
  assert.ok(names.includes('skill_novel_writer_system_draft'))
  // Other-domain tools that were never in the document whitelist stay out
  assert.ok(!names.includes('browser_click'))
  assert.ok(!names.includes('memory_save'))
})
