const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

const {
  checkAtomicWrites,
} = require('../check-atomic-write.cjs')

test('check-atomic-write rejects direct JSON state writes', () => {
  const root = makeFixture()
  try {
    writeFileSync(
      join(root, 'src/main/modules/agent-control/bad.ts'),
      "import { writeFileSync } from 'node:fs'\nwriteFileSync('foo.json', '{}')\n",
    )

    const result = checkAtomicWrites({ root })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /bad\.ts/)
    assert.match(result.errors.join('\n'), /foo\.json/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-atomic-write rejects nested path JSON writes', () => {
  const root = makeFixture()
  try {
    writeFileSync(
      join(root, 'src/main/modules/skills-runtime/bad-nested.ts'),
      [
        "import { writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "writeFileSync(join(root, 'state.json'), JSON.stringify({ ok: true }), 'utf8')",
        '',
      ].join('\n'),
    )

    const result = checkAtomicWrites({ root })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /bad-nested\.ts/)
    assert.match(result.errors.join('\n'), /state\.json/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-atomic-write rejects async fs.writeFile JSON writes', () => {
  const root = makeFixture()
  try {
    writeFileSync(
      join(root, 'src/main/modules/agent-control/bad-async.ts'),
      [
        "import fs from 'node:fs'",
        "fs.writeFile('state.json', JSON.stringify({ ok: true }), () => {})",
        '',
      ].join('\n'),
    )

    const result = checkAtomicWrites({ root })

    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /bad-async\.ts/)
    assert.match(result.errors.join('\n'), /state\.json/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-atomic-write accepts helper usage and allowed non-json writes', () => {
  const root = makeFixture()
  try {
    writeFileSync(
      join(root, 'src/main/modules/agent-control/good.ts'),
      [
        "import { writeFileSync } from 'node:fs'",
        "import { atomicWriteJson } from './atomic-write'",
        "atomicWriteJson('foo.json', {})",
        "writeFileSync('generated.py', 'print(1)')",
        '',
      ].join('\n'),
    )

    const result = checkAtomicWrites({ root })

    assert.equal(result.ok, true, result.errors.join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ready-atomic-check-'))
  mkdirSync(join(root, 'src/main/modules/agent-control'), { recursive: true })
  mkdirSync(join(root, 'src/main/modules/skills-runtime'), { recursive: true })
  return root
}
