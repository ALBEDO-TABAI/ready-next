import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/agent-control/document-task-pipeline-executor.ts',
)

describe('document pipeline widget draft reprompt contract', () => {
  const source = readFileSync(EXECUTOR_PATH, 'utf8')

  it('evaluates the first attempt and returns early on success', () => {
    assert.match(
      source,
      /const firstAttempt = this\.evaluateWidgetDraftAttempt\(firstParsed,/,
    )
    assert.match(source, /if \(firstAttempt\.errors\.length === 0\) \{\s*return \{ draft: firstAttempt\.draft, cacheable: true \}/)
  })

  it('builds a 3-turn reprompt message sequence when the first attempt fails', () => {
    assert.match(
      source,
      /const repromptMessages: Array<\{ role: 'system' \| 'user' \| 'assistant'; content: string \}> = \[/,
    )
    assert.match(source, /\{ role: 'system', content: systemPrompt \}/)
    assert.match(source, /\{ role: 'user', content: userPrompt \}/)
    assert.match(source, /\{ role: 'assistant', content: firstRaw \|\| '\{\}' \}/)
    assert.match(source, /上一次输出的 componentSpec 未通过校验/)
    assert.match(source, /firstAttempt\.errors\.join\('\\n'\)/)
  })

  it('re-requests the pipeline with the reprompt messages override', () => {
    assert.match(
      source,
      /const secondRaw = await this\.requestDocumentPipelineSimpleText\(\{[\s\S]*?messages: repromptMessages,/,
    )
    assert.match(source, /this\.deps\.log\(`document pipeline widget draft attempt=2 rawChars=/)
  })

  it('falls back to evaluateWidgetDraftAttempt on second parse and surfaces errors', () => {
    assert.match(
      source,
      /const secondAttempt = this\.evaluateWidgetDraftAttempt\(secondParsed,/,
    )
    assert.match(source, /if \(secondAttempt\.errors\.length === 0\) \{\s*return \{ draft: secondAttempt\.draft, cacheable: true \}/)
  })

  it('treats null-parsed JSON as a validation failure so retry still fires', () => {
    assert.match(
      source,
      /if \(!parsed\) \{\s*const draft = this\.normalizePipelineWidgetDraft\(null, params\)\s*return \{ draft, errors: \['Widget 草稿未返回可解析 JSON'\] \}/,
    )
  })
})
