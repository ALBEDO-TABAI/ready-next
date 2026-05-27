import assert from 'node:assert/strict'
import test from 'node:test'

import { nextIntentId } from '../shared/browser-view-intent'

test('browser view intent ids stay above low persisted visibility gates after renderer reloads', () => {
  const first = nextIntentId()
  const second = nextIntentId()

  assert.ok(first > 1_000_000_000_000)
  assert.equal(second, first + 1)
})
