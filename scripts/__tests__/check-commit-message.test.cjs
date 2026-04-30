const assert = require('node:assert/strict')
const test = require('node:test')

const {
  checkCommitMessage,
} = require('../check-commit-message.cjs')

test('check-commit-message rejects deferred follow-up language', () => {
  const result = checkCommitMessage('feat(agent): wire A0 guard; as a follow-up clean the rest')

  assert.equal(result.ok, false)
})

test('check-commit-message accepts direct scoped implementation message', () => {
  const result = checkCommitMessage('feat(agent): implement A0 strategic foundation gates')

  assert.equal(result.ok, true)
})
