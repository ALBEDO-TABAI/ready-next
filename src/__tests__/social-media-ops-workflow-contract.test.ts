import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { BROWSER_INTERACTION_TOOL_NAMES } from '../main/modules/tools/browser-tool-catalog'

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
  const discipline = readFileSync(resolve(
    process.cwd(),
    'assets/prompts/browser/discipline.md',
  ), 'utf8')

  for (const text of [workflow, deepResearch, discipline]) {
    assert.doesNotMatch(text, /browser_collect\(mode=(?:research|start)\)/)
  }
  assert.match(workflow, /browser_research\(scope=current_site, queries=\[\.\.\.\]\)/)
  assert.match(workflow, /不要为每个关键词打开一个标签/)
  assert.match(discipline, /一次调用 `browser_research/)
})
