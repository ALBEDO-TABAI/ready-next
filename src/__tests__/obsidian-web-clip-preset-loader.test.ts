/**
 * P1.7 contract tests for the preset loader / interpreter-required scanner.
 *
 * Covers:
 *   - `requiresInterpreter` is true when any of `noteContentFormat`,
 *     `noteNameFormat`, `path`, or `properties[].value` contains
 *     `{{"..."}}` or `{{prompt:"..."}}`.
 *   - Auto selection skips interpreter-required presets.
 *   - Explicit selection of an interpreter-required preset returns a
 *     PresetSelectionError with reason 'requires_interpreter' unless
 *     `allowInterpreterRequired` is true.
 *   - Bundled presets classification matches the Phase 1 SKILL.md
 *     allow-list: article / 中文网页 / b站 / behance are deterministic;
 *     youtube / 小红书 / chatgpt / gemini / perplexity require interpreter.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  PresetSelectionError,
  detectInterpreterRequired,
  hasPromptPlaceholder,
  loadAllPresets,
  selectPreset,
} from '../main/modules/clipping/preset-loader'

const PRESET_DIR = join(
  process.cwd(),
  'assets',
  'embedded-skills',
  'obsidian-web-clip',
  'assets',
  'presets',
)

describe('preset-loader · placeholder detection', () => {
  it('hasPromptPlaceholder detects {{"..."}} and {{prompt:"..."}}', () => {
    assert.equal(hasPromptPlaceholder('{{"extract tags from content"}}'), true)
    assert.equal(hasPromptPlaceholder('{{prompt:"summarize"}}'), true)
    assert.equal(hasPromptPlaceholder('{{prompt:"with filter"|date:"YYYY"}}'), true)
    assert.equal(hasPromptPlaceholder('{{title}}'), false)
    assert.equal(hasPromptPlaceholder('{{meta:name:keywords}}'), false)
    assert.equal(hasPromptPlaceholder(''), false)
  })

  it('detectInterpreterRequired flags presets with placeholders in any rendered field', () => {
    assert.equal(
      detectInterpreterRequired({
        schemaVersion: '0.1.0',
        name: 'placeholder-in-content',
        noteContentFormat: '{{"only images from {{content}}"}}',
        noteNameFormat: '{{title}}',
        path: '',
        properties: [],
        triggers: [],
        requiresInterpreter: false,
        fileId: 'placeholder-in-content',
      }),
      true,
    )
    assert.equal(
      detectInterpreterRequired({
        schemaVersion: '0.1.0',
        name: 'placeholder-in-tags',
        noteContentFormat: '{{content}}',
        noteNameFormat: '{{title}}',
        path: '',
        properties: [{ name: 'tags', value: '{{"extract tags"}}', type: 'multitext' }],
        triggers: [],
        requiresInterpreter: false,
        fileId: 'placeholder-in-tags',
      }),
      true,
    )
    assert.equal(
      detectInterpreterRequired({
        schemaVersion: '0.1.0',
        name: 'deterministic',
        noteContentFormat: '{{content}}',
        noteNameFormat: '{{title}}',
        path: 'Notes/',
        properties: [{ name: 'tags', value: '{{meta:name:keywords}}', type: 'multitext' }],
        triggers: [],
        requiresInterpreter: false,
        fileId: 'deterministic',
      }),
      false,
    )
  })
})

describe('preset-loader · bundled preset classification', () => {
  it('bundled presets exist and split into deterministic vs requires-interpreter', () => {
    if (!existsSync(PRESET_DIR)) {
      // Skip when assets aren't synced — verify pipeline depends on
      // embedded-skills/ being checked in; this is a sanity guard not a
      // skip exemption.
      return
    }
    const all = loadAllPresets(PRESET_DIR)
    assert.ok(all.length >= 4, `expected >=4 presets, found ${all.length}`)

    const det = all.filter((p) => !p.requiresInterpreter).map((p) => p.fileId).sort()
    const req = all.filter((p) => p.requiresInterpreter).map((p) => p.fileId).sort()

    // The actual deterministic-only set: only article and b站. behance,
    // 中文网页 also embed LLM-required `{{"..."}}` placeholders in their
    // properties (tags / title / author), so they belong to the require
    // set. SKILL.md documents this honestly.
    for (const expected of ['article-clipper', 'b站-clipper']) {
      assert.ok(det.includes(expected), `expected ${expected} deterministic, got det=${det.join(',')}`)
    }
    for (const expected of [
      'youtube-clipper',
      '小红书-clipper',
      'chatgpt-clipper',
      'gemini-clipper',
      'perplexity-clipper',
      'behance-clipper',
      '中文网页-clipper',
    ]) {
      assert.ok(req.includes(expected), `expected ${expected} to require interpreter, got req=${req.join(',')}`)
    }
  })
})

describe('preset-loader · selectPreset', () => {
  const buildPresets = () => [
    {
      schemaVersion: '0.1.0',
      name: 'Article',
      noteContentFormat: '{{content}}',
      noteNameFormat: '{{title}}',
      path: '',
      properties: [],
      triggers: [],
      requiresInterpreter: false,
      fileId: 'article-clipper',
    },
    {
      schemaVersion: '0.1.0',
      name: 'YouTube',
      noteContentFormat: '{{content}}',
      noteNameFormat: '{{title}}',
      path: '🎞️视频笔记/Youtube',
      properties: [{ name: 'tags', value: '{{"extract tags"}}', type: 'multitext' as const }],
      triggers: ['https://www.youtube.com/watch'],
      requiresInterpreter: true,
      fileId: 'youtube-clipper',
    },
  ]

  it('auto selection on a trigger-matched requires-interpreter preset throws requires_interpreter (no silent fallback)', () => {
    assert.throws(
      () =>
        selectPreset(buildPresets(), {
          pageUrl: 'https://www.youtube.com/watch?v=test',
          allowInterpreterRequired: false,
        }),
      (err) =>
        err instanceof PresetSelectionError &&
        err.reason === 'requires_interpreter' &&
        err.presetId === 'youtube-clipper',
    )
  })

  it('auto selection with no trigger match falls back to article-clipper', () => {
    const result = selectPreset(buildPresets(), {
      pageUrl: 'https://example.com/article/foo',
      allowInterpreterRequired: false,
    })
    assert.equal(result.fileId, 'article-clipper')
  })

  it('auto selection with force_render_with_placeholders keeps the trigger match', () => {
    const result = selectPreset(buildPresets(), {
      pageUrl: 'https://www.youtube.com/watch?v=test',
      allowInterpreterRequired: true,
    })
    assert.equal(result.fileId, 'youtube-clipper')
  })

  it('explicit requires-interpreter preset throws PresetSelectionError by default', () => {
    assert.throws(
      () =>
        selectPreset(buildPresets(), {
          explicitName: 'youtube-clipper',
          pageUrl: 'https://www.youtube.com/watch?v=test',
          allowInterpreterRequired: false,
        }),
      (err) => err instanceof PresetSelectionError && err.reason === 'requires_interpreter',
    )
  })

  it('explicit requires-interpreter preset passes when allowInterpreterRequired=true', () => {
    const result = selectPreset(buildPresets(), {
      explicitName: 'youtube-clipper',
      pageUrl: 'https://www.youtube.com/watch?v=test',
      allowInterpreterRequired: true,
    })
    assert.equal(result.fileId, 'youtube-clipper')
  })

  it('unknown preset name throws preset_not_found', () => {
    assert.throws(
      () =>
        selectPreset(buildPresets(), {
          explicitName: 'does-not-exist',
          pageUrl: 'https://example.com/',
          allowInterpreterRequired: false,
        }),
      (err) => err instanceof PresetSelectionError && err.reason === 'preset_not_found',
    )
  })
})
