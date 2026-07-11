'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const test = require('node:test')

test('Dynamic Delivery live gate passes on the repository', () => {
  const root = path.resolve(__dirname, '../..')
  const result = spawnSync(process.execPath, ['scripts/check-dynamic-delivery-live.cjs'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /ok/)
})
