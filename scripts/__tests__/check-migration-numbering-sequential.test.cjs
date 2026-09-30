const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { readMigrationNumbers, sequenceErrors } = require('../check-migration-numbering-sequential.cjs')

test('migration gate includes imported constants and cannot silently skip gaps or dynamic names', () => {
  const root = mkdtempSync(join(tmpdir(), 'migration-registry-gate-'))
  const registry = join(root, 'migrations.ts'), next = join(root, 'next.ts')
  try {
    writeFileSync(registry, "import { NEXT } from './next'; const migrations = [{ name: '001_initial' }, { name: NEXT }]")
    writeFileSync(next, "export const NEXT = '002_next'")
    assert.deepEqual(readMigrationNumbers(registry), [1, 2])
    assert.deepEqual(sequenceErrors(readMigrationNumbers(registry)), [])
    writeFileSync(next, "export const NEXT = '003_gap'")
    assert.equal(sequenceErrors(readMigrationNumbers(registry)).length, 1)
    writeFileSync(next, 'export const NEXT = createDynamicName()')
    assert.throws(() => readMigrationNumbers(registry), /Unresolved/)
    assert.equal(sequenceErrors([2, 3]).length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
