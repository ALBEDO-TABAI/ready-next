import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const { check } = createRequire(import.meta.url)('../../scripts/check-library-style-isolation.cjs')
test('style gate rejects unscoped selectors, escaping siblings and rules without a layer', () => {
  assert.deepEqual(check('@layer ready-next.library { .rn-library button, .rn-library .sheet {color:red} }', 'fixture'), [])
  for (const css of ['.rn-library button {color:red}', '@layer ready-next.library { .rn-library button, body {color:red} }', '@layer ready-next.library { .rn-library + div {color:red} }']) assert.ok(check(css, 'fixture').length)
})
