'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join, dirname } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  check,
  STUB_REL,
  TURN_ENGINE_REL,
} = require('../check-l2-stub-not-in-production-path.cjs')

function makeFixture({ stubContent, turnEngineContent }) {
  const root = mkdtempSync(join(tmpdir(), 'check-l2-stub-'))
  if (stubContent !== null) {
    const stubAbs = join(root, STUB_REL)
    mkdirSync(dirname(stubAbs), { recursive: true })
    writeFileSync(stubAbs, stubContent)
  }
  if (turnEngineContent !== null) {
    const teAbs = join(root, TURN_ENGINE_REL)
    mkdirSync(dirname(teAbs), { recursive: true })
    writeFileSync(teAbs, turnEngineContent)
  }
  return root
}

test('passes when stub has both markers and turn-engine does not import it', () => {
  const root = makeFixture({
    stubContent: `/**\n * stub-only — not in production path.\n */\nexport const noop = () => null\n`,
    turnEngineContent: `// no compactor stub here\nexport function execute() {}\n`,
  })
  try {
    const r = check({ root })
    assert.equal(r.ok, true, r.errors?.join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when stub is missing the "stub-only" marker', () => {
  const root = makeFixture({
    stubContent: `/** not in production path */\nexport const noop = () => null\n`,
    turnEngineContent: `export function execute() {}\n`,
  })
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /stub-only/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when stub is missing the "not in production path" marker', () => {
  const root = makeFixture({
    stubContent: `/** stub-only */\nexport const noop = () => null\n`,
    turnEngineContent: `export function execute() {}\n`,
  })
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /not in production path/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when turn-engine references the stub module', () => {
  const root = makeFixture({
    stubContent: `/** stub-only — not in production path */\nexport const noop = () => null\n`,
    turnEngineContent: `import { noop } from './layered-compactor-l2-stub'\nexport function execute() { noop() }\n`,
  })
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /layered-compactor-l2-stub/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when stub source file is missing', () => {
  const root = makeFixture({
    stubContent: null,
    turnEngineContent: `export function execute() {}\n`,
  })
  try {
    const r = check({ root })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => /Missing/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
