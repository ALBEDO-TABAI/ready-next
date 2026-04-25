import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('file_locate falls back to a workspace file when the search index has not caught up', () => {
  const fileManagementTools = readWorkspaceFile('src/main/modules/tools/file-management-tools.ts')

  assert.doesNotMatch(
    fileManagementTools,
    /if \(!row\) return toJsonString\(\{ ok: false, error: 'path not in index' \}\)/,
  )
  assert.match(fileManagementTools, /if \(!row\) \{[\s\S]*assertInsideWorkspace\(path, engine\)/)
  assert.match(fileManagementTools, /if \(!row\) \{[\s\S]*engine\.indexDocument\(guard\.root, path\)/)
})
