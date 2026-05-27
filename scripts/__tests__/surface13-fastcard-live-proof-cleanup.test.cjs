const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

test('surface13 live proof cleans temporary browser fixture tabs after proof', () => {
  const source = readFileSync(resolve(process.cwd(), 'scripts/run-surface13-fastcard-live-proof.mjs'), 'utf8')

  assert.match(source, /function buildCleanupSurface13TabsExpression\(fixtureUrl\)/)
  assert.ok(source.includes('surface13-clip-agent'), 'cleanup must target the Surface13 fixture tabs')
  assert.match(source, /await api\.closeTab\(tab\.id\)/)
  assert.match(source, /report\.fixtureTabCleanup = await cleanupSurface13FixtureTabs\(fixtureServer\.url\)/)
  assert.match(source, /&& report\.fixtureTabCleanup\?\.ok/)
})
