import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { BROWSER_INTERACTION_TOOL_NAMES } from '../main/modules/tools/browser-tool-catalog'
import { BROWSER_TOOL_SCHEMAS } from '../main/modules/tools/schemas/browser-tool-schemas'

test('social media operations visual workflow uses a model-readable browser tool', () => {
  const workflow = readFileSync(resolve(
    process.cwd(),
    'assets/embedded-skills/social-media-ops/references/ready-workflows.md',
  ), 'utf8')

  assert.ok(BROWSER_INTERACTION_TOOL_NAMES.includes('browser_screenshot'))
  assert.match(workflow, /视觉判断[^\n]*`browser_screenshot`/)
  assert.doesNotMatch(workflow, /`browser_screenshot`[^\n]{0,80}\+\s*视觉分析/)
})

test('embedded research guidance uses the dedicated browser research contract', () => {
  const workflow = readFileSync(resolve(
    process.cwd(),
    'assets/embedded-skills/social-media-ops/references/ready-workflows.md',
  ), 'utf8')
  const deepResearch = readFileSync(resolve(
    process.cwd(),
    'assets/embedded-skills/deep-research/SKILL.md',
  ), 'utf8')
  for (const text of [workflow, deepResearch]) {
    assert.doesNotMatch(text, /browser_collect\(mode=(?:research|start)\)/)
  }
  assert.doesNotMatch(workflow, /\b(?:scope|queries|fields|evaluate_source|task_id|evidence_fields|query_outcome)\s*=/)
  assert.match(workflow, /不要为每个关键词打开一个标签/)

  const calls = Array.from(workflow.matchAll(/`(browser_(?:research|read))\((\{[^\n`]+\})\)`/g))
  assert.ok(calls.length >= 4)
  const researchActions = new Set<string>()
  for (const [, name, rawArgs] of calls) {
    const args = JSON.parse(rawArgs) as Record<string, unknown>
    const parsed = BROWSER_TOOL_SCHEMAS[name as 'browser_research' | 'browser_read'].safeParse(args)
    assert.equal(parsed.success, true, `${name} example must match the live schema`)
    if (name === 'browser_research') researchActions.add(String(args.action || 'start'))
  }
  assert.deepEqual(researchActions, new Set(['start', 'evidence', 'complete']))
})
