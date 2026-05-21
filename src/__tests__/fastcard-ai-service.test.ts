import assert from 'node:assert/strict'
import test from 'node:test'

import { formatFastCardModelHttpError } from '../main/modules/browser-engine/fastcard-ai-service'

test('FastCard model errors explain supplier 402 failures', () => {
  const message = formatFastCardModelHttpError(402, JSON.stringify({
    error: { message: 'Insufficient Balance' },
  }))

  assert.match(message, /余额不足/)
  assert.match(message, /402/)
  assert.match(message, /Insufficient Balance/)
})

test('FastCard model errors explain common authorization and rate limit failures', () => {
  assert.match(formatFastCardModelHttpError(401), /API Key/)
  assert.match(formatFastCardModelHttpError(403), /没有权限/)
  assert.match(formatFastCardModelHttpError(429), /限流/)
})
