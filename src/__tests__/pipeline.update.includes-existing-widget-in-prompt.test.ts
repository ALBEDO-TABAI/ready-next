import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/document-pipeline/document-task-pipeline-executor.ts',
)

describe('pipeline update-mode existing widget prompt contract (P3 T2)', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')

  it('collects existing widgets only for update operation', () => {
    assert.match(
      source,
      /const existingWidgets = params\.plan\.operation === 'update'\s*\?\s*this\.collectExistingWidgetsForPrompt\(params\.snapshot,\s*\d+\)\s*:\s*\[\]/,
    )
  })

  it('serializes each existing widget with title, mode and widgetCode so the LLM sees the component type', () => {
    assert.match(
      source,
      /private serializeExistingWidgetsForPrompt\(records: DocumentWidgetRecord\[\]\): string \{[\s\S]*?index: record\.index,\s*title: record\.title,\s*mode: record\.mode,[\s\S]*?widgetCode: this\.clipWidgetCodeForPrompt\(record\.widgetCode\)/,
    )
    assert.match(source, /component: record\.componentSpec\?\.component \|\| null/)
    assert.match(source, /canPatch: Boolean\(record\.componentSpec\)/)
  })

  it('places the existing widget block in the user prompt before the insight JSON', () => {
    const userPromptFn = source.match(
      /private buildWidgetDraftUserPrompt\([\s\S]*?return segments\.join\('\\n'\)\n\s*\}/,
    )
    assert.ok(userPromptFn, 'buildWidgetDraftUserPrompt not found')
    const body = userPromptFn![0]
    const existingIdx = body.indexOf('现有 widget（update 候选')
    const insightIdx = body.indexOf('insight JSON')
    assert.ok(existingIdx > -1, 'existing widget block label missing')
    assert.ok(insightIdx > -1, 'insight JSON label missing')
    assert.ok(
      existingIdx < insightIdx,
      'existing widget block must precede insight JSON so the LLM anchors on the current widget first',
    )
  })

  it('locks the update system prompt to "same component" rule when existing widgets are present', () => {
    assert.match(
      source,
      /params\.plan\.operation === 'update' && params\.hasExistingWidgets\) \{[\s\S]*?必须沿用同一组件/,
    )
  })

  it('skips the existing widget block for create operation (no leakage)', () => {
    const userPromptFn = source.match(
      /private buildWidgetDraftUserPrompt\([\s\S]*?return segments\.join\('\\n'\)\n\s*\}/,
    )
    assert.ok(userPromptFn, 'buildWidgetDraftUserPrompt not found')
    const body = userPromptFn![0]
    assert.match(
      body,
      /if \(params\.plan\.operation === 'update' && params\.existingWidgets\.length > 0\) \{\s*segments\.push\('现有 widget（update 候选/,
      'existing widget push must be guarded by update mode + non-empty widgets',
    )
  })
})
