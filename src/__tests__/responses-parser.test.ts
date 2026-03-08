import { describe, it } from 'node:test'
import assert from 'node:assert'

import { parseJsonOrEventStreamText } from '../main/modules/openai-responses'

describe('parseJsonOrEventStreamText', () => {
  it('parses plain json payloads', () => {
    const payload = parseJsonOrEventStreamText('{"id":"resp_1","output_text":"hello"}') as { output_text?: string }
    assert.strictEqual(payload.output_text, 'hello')
  })

  it('extracts completed response from sse payloads', () => {
    const payload = parseJsonOrEventStreamText([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output_text":"Hi there"}}',
      '',
    ].join('\n')) as { id?: string; status?: string; output_text?: string }

    assert.strictEqual(payload.id, 'resp_1')
    assert.strictEqual(payload.status, 'completed')
    assert.strictEqual(payload.output_text, 'Hi there')
  })
})
