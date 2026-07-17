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
