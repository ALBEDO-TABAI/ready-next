import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  classifyTestFile,
  isSerialPerformanceTestFile,
  isSkillChildTestFile,
} = require('../../scripts/test-file-groups.cjs') as {
  classifyTestFile: (name: string) => 'parallel' | 'skill_child' | 'serial_performance' | null
  isSerialPerformanceTestFile: (name: string) => boolean
  isSkillChildTestFile: (name: string) => boolean
}

test('test runners share exact, non-overlapping file-group predicates', () => {
  assert.equal(isSerialPerformanceTestFile('graph.serial.test.ts'), true)
  assert.equal(isSerialPerformanceTestFile('graph.serial.test.tsx'), true)
  assert.equal(isSerialPerformanceTestFile('graph.serial.test.helper.test.ts'), false)
  assert.equal(isSerialPerformanceTestFile('graph.test.ts'), false)

  assert.equal(isSkillChildTestFile('skill-child-runner.test.ts'), true)
  assert.equal(isSkillChildTestFile('skill-child-runner.test.tsx'), true)
  assert.equal(isSkillChildTestFile('unrelated.test.ts'), false)
})

test('every top-level test belongs to exactly one runtime group', () => {
  const names = readdirSync(resolve(process.cwd(), 'src/__tests__'))
    .filter((name) => name.endsWith('.test.ts') || name.endsWith('.test.tsx'))
  const groups = new Map(names.map((name) => [name, classifyTestFile(name)]))

  assert.equal([...groups.values()].some((group) => group === null), false)
  assert.equal([...groups.values()].filter((group) => group === 'serial_performance').length > 0, true)
  assert.equal([...groups.values()].filter((group) => group === 'skill_child').length > 0, true)
  assert.equal(groups.size, names.length)
})
