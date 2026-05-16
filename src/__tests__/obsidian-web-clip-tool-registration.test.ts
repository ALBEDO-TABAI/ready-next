/**
 * P1.2 contract tests for `web_clip_url` registration across the §6.25
 * Stage R 8-contract surface and adjacent gates.
 *
 * Covers:
 *   - `WEB_CLIP_URL` listed in `GENERAL_RESEARCH_TOOL_NAMES`.
 *   - `web_clip_url` present in `GENERAL_RESEARCH_SCHEMAS` (spread point for
 *     `STATIC_TOOL_INPUT_SCHEMAS`).
 *   - `getToolResourceTag('web_clip_url')` returns
 *     `{ domain: 'general_research', accessMode: 'interactive' }`.
 *   - `ResearchDomainAdapter.prepare()` includes `web_clip_url` in both
 *     browser-mode and non-browser-mode prefix sets when the upstream
 *     allow-list contains it.
 *   - `browser:clipCurrentTab` IPC name is NOT present in any model-facing
 *     tool name list (host-IPC-only invariant).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  GENERAL_RESEARCH_TOOL_NAMES,
  GENERAL_RESEARCH_TOOLS,
} from '../main/modules/tools/general-research-tool-defs'
import { GENERAL_RESEARCH_SCHEMAS } from '../main/modules/tools/schemas/general-research-schemas'
import { getToolResourceTag } from '../main/modules/agent-control/tool-parallelism-policy'

describe('web_clip_url · capability group registration', () => {
  it('appears in GENERAL_RESEARCH_TOOL_NAMES', () => {
    assert.ok(GENERAL_RESEARCH_TOOL_NAMES.includes('web_clip_url'))
  })

  it('appears in GENERAL_RESEARCH_TOOLS with required fields', () => {
    const entry = GENERAL_RESEARCH_TOOLS.find((t) => t.name === 'web_clip_url')
    assert.ok(entry, 'web_clip_url tool def missing')
    assert.ok(entry.description.length > 50, 'description too short')
    const paramNames = entry.params.map((p) => p.name).sort()
    assert.ok(paramNames.includes('url'), `params missing url: ${paramNames.join(',')}`)
    assert.ok(paramNames.includes('preset'), `params missing preset: ${paramNames.join(',')}`)
    assert.ok(paramNames.includes('force_render_with_placeholders'), `params missing force flag`)
  })

  it('schema is spread into GENERAL_RESEARCH_SCHEMAS', () => {
    assert.ok(GENERAL_RESEARCH_SCHEMAS.web_clip_url, 'web_clip_url schema not spread')
  })
})

describe('web_clip_url · resource tag', () => {
  it('classified as general_research/interactive (writes + present_file → serialized)', () => {
    const tag = getToolResourceTag('web_clip_url')
    assert.equal(tag.domain, 'general_research')
    assert.equal(tag.accessMode, 'interactive')
  })
})

describe('browser:clipCurrentTab · host-IPC-only invariant', () => {
  it('is NOT present in model-facing GENERAL_RESEARCH_TOOL_NAMES', () => {
    for (const candidate of [
      'browser_clip_current_tab',
      'browser:clipCurrentTab',
      'clip_current_tab',
    ]) {
      assert.equal(
        GENERAL_RESEARCH_TOOL_NAMES.includes(candidate),
        false,
        `forbidden name leaked into model surface: ${candidate}`,
      )
    }
  })

  it('is NOT present in GENERAL_RESEARCH_SCHEMAS', () => {
    for (const candidate of [
      'browser_clip_current_tab',
      'browser:clipCurrentTab',
      'clip_current_tab',
    ]) {
      assert.equal(
        Object.keys(GENERAL_RESEARCH_SCHEMAS).includes(candidate),
        false,
        `forbidden schema leaked: ${candidate}`,
      )
    }
  })
})
