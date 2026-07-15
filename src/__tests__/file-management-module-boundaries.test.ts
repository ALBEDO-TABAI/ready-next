import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const MODULES = [
  'src/main/modules/tools/file-management-tools.ts',
  'src/main/modules/tools/file-management-runtime.ts',
  'src/main/modules/tools/file-management-organize-tools.ts',
  'src/main/modules/tag-forge/tag-forge-batch-tools.ts',
] as const

function source(path: string): string {
  return readFileSync(path, 'utf8')
}

test('file-management implementations stay below the healthy-file threshold', () => {
  for (const path of MODULES) {
    const lines = source(path).split('\n').length
    assert.ok(lines <= 1000, `${path} must stay at or below 1000 lines, received ${lines}`)
  }
})

test('the public file-management entry does not own stateful batch or organizer internals', () => {
  const facade = source('src/main/modules/tools/file-management-tools.ts')
  assert.doesNotMatch(facade, /type TagForgeBatchState|type TagForgeBatchItemState/)
  assert.doesNotMatch(facade, /type OrganizePlan|type OrganizeJournal/)
  assert.doesNotMatch(facade, /function runTagForge(?:Prepare|Apply|Review)Batch/)
  assert.doesNotMatch(facade, /function runFileOrganize(?:Preview|Apply|Undo)/)
})
