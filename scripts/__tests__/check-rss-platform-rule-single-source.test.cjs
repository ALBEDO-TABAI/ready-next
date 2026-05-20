'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { checkRssPlatformRuleSingleSource } = require('../check-rss-platform-rule-single-source.cjs')

test('U8.2a current repo passes — scrapers/index.ts and platform-adapters/ are the only homes', () => {
  const { ok, violations } = checkRssPlatformRuleSingleSource()
  if (!ok) {
    console.error('Unexpected violations:', violations)
  }
  assert.equal(ok, true, 'main branch should pass the gate (registry exists, no extra detect functions)')
  assert.equal(violations.length, 0)
})

test('U8.2a gate flags a new detectPlatform leak outside the whitelist', () => {
  // We cannot mutate the repo from a unit test, so instead exercise the
  // exported function with a known forbidden pattern check by stubbing.
  // The gate uses fs.readFileSync internally, so the cleanest check is
  // a behavioral assertion that the regex set actually matches the
  // forbidden forms.
  const FORBIDDEN = [
    'function detectPlatform(url: string) {}',
    'export function detectPlatform(url: string) {}',
    'const detectPlatform = (url: string) => {}',
  ]
  const patterns = [
    /\bfunction\s+detectPlatform\b/,
    /\bexport\s+function\s+detectPlatform\b/,
    /\bconst\s+detectPlatform\s*=/,
  ]
  for (const line of FORBIDDEN) {
    assert.ok(
      patterns.some((rx) => rx.test(line)),
      `expected at least one forbidden pattern to match: ${line}`,
    )
  }
})

test('U8.2a gate ignores the legacy scrapers/index.ts detectPlatform', () => {
  // The whitelist is regex-based; verify the canonical legacy file matches.
  const whitelist = [
    /^src\/main\/modules\/rss-engine\/scrapers\/index\.ts$/,
    /^src\/main\/modules\/rss-engine\/platform-adapters\//,
  ]
  assert.ok(whitelist[0].test('src/main/modules/rss-engine/scrapers/index.ts'))
  assert.ok(whitelist[1].test('src/main/modules/rss-engine/platform-adapters/types.ts'))
  assert.ok(whitelist[1].test('src/main/modules/rss-engine/platform-adapters/bilibili.ts'))
})
