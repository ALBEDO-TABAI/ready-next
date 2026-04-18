import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

// Static-source contract tests — the executor module pulls in electron, so we
// assert the critical prompt structure by inspecting the source.

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/document-task-pipeline-executor.ts',
)

describe('document pipeline widget draft prompt contract', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')

  it('injects describeApprovedWidgetProps into the widget-draft system prompt', () => {
    assert.match(source, /describeApprovedWidgetProps\(this\.approvedWidgetComponentNames\)/)
    assert.match(source, /每个允许的组件 props 字段/)
    assert.match(source, /所有必填字段都必须出现且非空/)
  })

  it('adds the same-component rule for update mode when existing widgets are present', () => {
    assert.match(source, /必须沿用同一组件/)
    assert.match(source, /params\.plan\.operation === 'update' && params\.hasExistingWidgets/)
  })

  it('places existing widget block before the insight JSON in user prompt', () => {
    const userPromptFn = source.match(
      /private buildWidgetDraftUserPrompt\([\s\S]*?return segments\.join\('\\n'\)\n\s*\}/,
    )
    assert.ok(userPromptFn, 'buildWidgetDraftUserPrompt not found')
    const body = userPromptFn![0]
    const existingIndex = body.indexOf('现有 widget（update 候选')
    const insightIndex = body.indexOf('insight JSON')
    assert.ok(existingIndex > -1, 'existing widget block missing')
    assert.ok(insightIndex > -1, 'insight JSON block missing')
    assert.ok(existingIndex < insightIndex, 'existing widget block must appear before insight JSON')
  })

  it('only collects existing widgets for update mode', () => {
    assert.match(
      source,
      /params\.plan\.operation === 'update'\s*\?\s*this\.collectExistingWidgetsForPrompt\(params\.snapshot,\s*\d+\)/,
    )
  })

  it('clips widgetCode to bounded character count', () => {
    assert.match(source, /clipWidgetCodeForPrompt\(widgetCode: string, maxChars = 1000\)/)
  })
})
