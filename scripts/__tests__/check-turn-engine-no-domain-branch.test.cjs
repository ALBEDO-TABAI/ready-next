'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const GATE_PATH = path.resolve(__dirname, '..', 'check-turn-engine-no-domain-branch.cjs')

function extractPatterns() {
  const source = fs.readFileSync(GATE_PATH, 'utf8')
  const m = source.match(/const FORBIDDEN_PATTERNS = \[([\s\S]*?)\n\]/)
  if (!m) throw new Error('cannot find FORBIDDEN_PATTERNS in gate source')
  const stripped = m[1].replace(/\/\/[^\n]*/g, '').trim()
  return (new Function(`return [${stripped}]`))()
}

const PATTERNS = extractPatterns()
function anyMatch(line) { return PATTERNS.some((p) => p.test(line)) }

test('U1.4 gate matches adapter.id === dotted form (codex review v2 regression guard)', () => {
  assert.equal(anyMatch("if (adapter.id === 'browser') return"), true)
  assert.equal(anyMatch("if (adapter.id === 'pet') doSomething()"), true)
  assert.equal(anyMatch("if (adapter.id === 'rss') {}"), true)
})

test('U1.4 gate matches adapterId / sourceAdapterId camelCase form', () => {
  assert.equal(anyMatch("if (adapterId === 'document') return"), true)
  assert.equal(anyMatch("if (sourceAdapterId === 'feishu') {}"), true)
})

test('U1.4 gate matches domain.id / domainId === product', () => {
  assert.equal(anyMatch("if (domain.id === 'calendar') {}"), true)
  assert.equal(anyMatch("if (domainId === 'rss') return"), true)
})

test('U1.4 gate matches case "<domain>" switch arm', () => {
  assert.equal(anyMatch("    case 'browser':"), true)
  assert.equal(anyMatch("case 'pet':"), true)
})

test('U1.4 gate does NOT match unrelated identifiers', () => {
  assert.equal(anyMatch("if (otherThing === 'browser') return"), false)
  assert.equal(anyMatch("const x = 'browser'"), false)
})
