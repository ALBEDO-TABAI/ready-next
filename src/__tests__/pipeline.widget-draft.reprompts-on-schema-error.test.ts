import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/document-engine/pipeline/document-task-pipeline-executor.ts',
)

describe('pipeline widget draft reprompt-on-schema-error contract (P3 T1)', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')

  it('carries the zod validator errors verbatim into the reprompt user message', () => {
    assert.match(
      source,
      /\{\s*role: 'user',\s*content: \[\s*'上一次输出的 componentSpec 未通过校验：',\s*firstAttempt\.errors\.join\('\\n'\),/,
    )
  })

  it('routes the second attempt through requestDocumentPipelineSimpleText with messages: repromptMessages', () => {
    assert.match(
      source,
      /const secondRaw = await this\.requestDocumentPipelineSimpleText\(\{[\s\S]*?messages: repromptMessages,[\s\S]*?\}\)/,
    )
  })

  it('uses validateDocumentWidgetComponentSpec inside evaluateWidgetDraftAttempt so schema errors are what drives the retry', () => {
    assert.match(
      source,
      /private validateDraftComponentSpec\(draft: DocumentWidgetDraft\): string\[\] \{[\s\S]*?validateDocumentWidgetComponentSpec\(draft\.componentSpec\)/,
    )
    assert.match(
      source,
      /errors\.push\(\.\.\.this\.validateDraftComponentSpec\(draft\)\)/,
    )
  })

  it('caps reprompt at exactly one retry (no N-turn loop)', () => {
    const firstIdx = source.indexOf('attempt=1 rawChars=')
    const secondIdx = source.indexOf('attempt=2 rawChars=')
    const thirdIdx = source.indexOf('attempt=3 rawChars=')
    assert.ok(firstIdx > 0, 'attempt 1 log missing')
    assert.ok(secondIdx > firstIdx, 'attempt 2 log missing or out of order')
    assert.equal(thirdIdx, -1, 'attempt 3 must not exist; the retry budget is 1 additional turn')
  })

  it('tags the successful reprompt result as cacheable so only schema-valid drafts are stored', () => {
    assert.match(
      source,
      /if \(secondAttempt\.errors\.length === 0\) \{\s*return \{ draft: secondAttempt\.draft, cacheable: true \}/,
    )
  })
})
