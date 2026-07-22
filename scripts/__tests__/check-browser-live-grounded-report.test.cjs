const assert = require('node:assert/strict')
const test = require('node:test')

const { validateBrowserLiveGroundedReport } = require('../check-browser-live-grounded-report.cjs')

test('live validator rejects an empty or pre-stored success report', () => {
  const result = validateBrowserLiveGroundedReport({ ok: true }, { root: process.cwd() })
  assert.equal(result.ok, false)
  assert.ok(result.errors.includes('proof nonce mismatch'))
  assert.ok(result.errors.includes('A1-A12 matrix missing'))
  assert.ok(result.errors.includes('three successful Xiaohongshu runs missing'))
})
