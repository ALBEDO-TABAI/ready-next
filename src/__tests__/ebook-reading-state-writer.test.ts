import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EbookReadingStateWriter,
  type EbookReaderState,
} from '../renderer/modules/document/ebookReadingStateWriter'

function state(fraction: number): EbookReaderState {
  return {
    path: '/tmp/book.epub',
    size: 1024,
    modifiedTime: 7,
    fraction,
    updatedAt: fraction,
  }
}

test('ebook relocate bursts write only the latest position when flushed', () => {
  const writes: EbookReaderState[] = []
  const writer = new EbookReadingStateWriter((next) => writes.push(next), 60_000)

  for (let index = 0; index < 50; index += 1) writer.queue(state(index / 50))

  assert.equal(writes.length, 0)
  assert.equal(writer.flush(), true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].fraction, 49 / 50)
  assert.equal(writer.flush(), false)
})
