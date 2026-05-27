'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

test('video panel acceptance default wait covers the VEA action timeout', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/run-agent-panel-video-acceptance.mjs'), 'utf8')

  assert.match(source, /const VEA_ACTION_TIMEOUT_MS = 3 \* 60 \* 60_000/)
  assert.match(source, /const VIDEO_ACCEPTANCE_TIMEOUT_MARGIN_MS = 5 \* 60_000/)
  assert.match(source, /const DEFAULT_WAIT_MS = VEA_ACTION_TIMEOUT_MS \+ VIDEO_ACCEPTANCE_TIMEOUT_MARGIN_MS/)
  assert.match(source, /waitMs: DEFAULT_WAIT_MS/)
  assert.match(source, /Number\.isFinite\(parsed\.waitMs\) \? parsed\.waitMs : DEFAULT_WAIT_MS/)
})
