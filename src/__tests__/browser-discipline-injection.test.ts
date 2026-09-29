import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { z } from 'zod'

import { PromptAssetLoader } from '../main/modules/agent-control/prompt-assets/loader'
import {
  BROWSER_DISCIPLINE_MAJOR
} from '../main/modules/agent-control/domain-adapters/browser-discipline-asset'
import { BROWSER_TOOL_SCHEMAS } from '../main/modules/tools/schemas/browser-tool-schemas'
import { BROWSER_PUBLIC_TOOL_NAMES } from '../shared/browser-tool-surface'

test('shipped discipline is complete, current, and not silently clipped', () => {
  const loader = new PromptAssetLoader({ roots: [join(process.cwd(), 'assets', 'prompts')] })
  const asset = loader.load('browser/discipline')
  const rendered = loader.render('browser/discipline')
  assert.equal(asset.name, 'browser-discipline')
  assert.equal(asset.version, String(BROWSER_DISCIPLINE_MAJOR))
  assert.ok(rendered.includes('source target provenance'))
  assert.ok(rendered.includes('observation receipt/resource'))
  assert.ok(rendered.includes('不能用一个汇总项代替多目标覆盖'))
  assert.ok(rendered.includes('0-999'))
  for (const removed of [
    'evaluate_source',
    'evidence_fields',
    'query_outcome',
    'image_gallery',
    '0-1000',
    '禁止 href',
    '两连败',
    'browser_research(action=start',
  ]) {
    assert.ok(!rendered.includes(removed), `removed Browser contract must stay absent: ${removed}`)
  }
})

test('discipline tool and parameter claims resolve against the canonical registry schemas', () => {
  const rendered = new PromptAssetLoader({ roots: [join(process.cwd(), 'assets', 'prompts')] })
    .render('browser/discipline')
  const mentionedTools = [...new Set(rendered.match(/browser_[a-z_]+/g) || [])]
  for (const toolName of mentionedTools) {
    assert.ok(BROWSER_PUBLIC_TOOL_NAMES.includes(toolName as never), `unknown discipline tool: ${toolName}`)
  }
  const click = z.toJSONSchema(BROWSER_TOOL_SCHEMAS.browser_click) as Record<string, unknown>
  const clickProperties = click.properties as Record<string, Record<string, unknown>>
  assert.equal(clickProperties.x.minimum, 0)
  assert.equal(clickProperties.x.maximum, 999)
  assert.equal(clickProperties.y.minimum, 0)
  assert.equal(clickProperties.y.maximum, 999)
})
