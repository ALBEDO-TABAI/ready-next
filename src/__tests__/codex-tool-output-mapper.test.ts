import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mapReadyToolOutput } from '../main/modules/agent-control/codex-runtime/codex-tool-output-mapper'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { createBrowserStructuredOutput } from '../main/modules/tools/browser-failure-output'
import { deriveEnvelopeForToolOutput } from '../main/modules/tools/tool-result-envelope'

function modelFacing(output: ReturnType<typeof createToolExecutionOutput>): { raw: string; parsed: Record<string, unknown> } {
  const mapped = mapReadyToolOutput(output)
  const raw = mapped.contentItems.filter((item) => item.type === 'inputText').map((item) => item.text).join('')
  return { raw, parsed: JSON.parse(raw) as Record<string, unknown> }
}

describe('what a tool result looks like to the model', () => {
  it('sends the data once when the text is only the data written as JSON', () => {
    const page = { ok: true, url: 'https://example.test/a', content: '# Title\n\n' + 'A line of "quoted" text.\n'.repeat(200) }
    const output = createBrowserStructuredOutput(page)
    assert.equal(output.text, JSON.stringify(page, null, 2), 'the tool wrote its text by stringifying its data')

    const { raw, parsed } = modelFacing({ ...output, envelope: deriveEnvelopeForToolOutput(output) })
    assert.deepEqual(parsed.data, page)
    assert.deepEqual(parsed.envelope, { ok: true, kind: 'ok' })
    assert.equal('text' in parsed, false)
    assert.ok(raw.length < JSON.stringify(page).length + 200, `the page is carried once (${raw.length} chars)`)
  })

  it('keeps a text that says something the data does not', () => {
    const summary = createToolExecutionOutput('Saved 3 files to the project folder.', { shape: 'json', data: { ok: true, saved: 3 } })
    assert.equal(modelFacing(summary).parsed.text, 'Saved 3 files to the project folder.')

    const different = createToolExecutionOutput(JSON.stringify({ ok: true, saved: 3, note: 'extra' }), { shape: 'json', data: { ok: true, saved: 3 } })
    assert.equal(modelFacing(different).parsed.text, JSON.stringify({ ok: true, saved: 3, note: 'extra' }))

    const compact = createToolExecutionOutput(JSON.stringify({ saved: 3, ok: true }), { shape: 'json', data: { ok: true, saved: 3 } })
    assert.equal('text' in modelFacing(compact).parsed, false, 'key order and spacing do not make it a different text')
  })

  it('leaves a result that is only text as it was', () => {
    const mapped = mapReadyToolOutput(createToolExecutionOutput('plain words', { shape: 'text' }))
    assert.deepEqual(mapped.contentItems, [{ type: 'inputText', text: 'plain words' }])
  })

  it('still hides secrets and reports failure when the repeated text is dropped', () => {
    const failed = createBrowserStructuredOutput({ ok: false, errorKind: 'browser_reference_stale', token: 'abcdef123456', detail: 'Bearer abcdef123456' })
    const mapped = mapReadyToolOutput({ ...failed, envelope: deriveEnvelopeForToolOutput(failed) })
    const { raw, parsed } = modelFacing({ ...failed, envelope: deriveEnvelopeForToolOutput(failed) })
    assert.equal(mapped.success, false)
    assert.equal('text' in parsed, false)
    assert.equal((parsed.data as Record<string, unknown>).token, '[REDACTED]')
    assert.equal(raw.includes('abcdef123456'), false)
    assert.equal((parsed.envelope as { ok: boolean }).ok, false)
  })
})
