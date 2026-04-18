import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/document-task-pipeline-executor.ts',
)

describe('document pipeline widget draft fallback contract', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')

  it('throws (never falls back) in update mode when both attempts fail', () => {
    assert.match(
      source,
      /if \(params\.plan\.operation === 'update'\) \{\s*throw new Error\(`Widget componentSpec 两次校验失败：\$\{lastErrors\.join\('；'\)\}`\)/,
    )
  })

  it('produces the summary-card fallback draft for create mode only', () => {
    assert.match(
      source,
      /const fallbackDraft = this\.buildFallbackDocumentWidgetDraft\(\{[\s\S]*?targetWidgetTitle: secondAttempt\.draft\.targetWidgetTitle \|\| firstAttempt\.draft\.targetWidgetTitle/,
    )
    assert.match(source, /document pipeline widget draft fallback=applied mode=create/)
  })

  it('annotates the insight warnings list with the fallback reason', () => {
    assert.match(
      source,
      /this\.appendInsightWarning\(\s*params\.insight,\s*`已使用兜底摘要卡（原因：componentSpec 两次校验失败 · \$\{lastErrors\.join\('；'\)\}）`,\s*\)/,
    )
  })

  it('surfaces fallback warnings through executionDiagnostics.pipeline.document', () => {
    assert.match(
      source,
      /const fallbackWarnings = \(pipelineResult\.insight\?\.warnings \|\| \[\]\)\.filter/,
    )
    assert.match(source, /fallbackWarning: fallbackWarnings\[0\]/)
    assert.match(source, /fallbackWarnings,/)
  })

  it('keeps buildFallbackDocumentWidgetDraft as an info_card summary card', () => {
    assert.match(
      source,
      /private buildFallbackDocumentWidgetDraft\([\s\S]*?component: 'info_card'/,
    )
  })
})
