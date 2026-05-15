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
  assert.match(fileManagementTools, /resolveFileLocateCandidate\(requestedPath, engine\)/)
  assert.match(fileManagementTools, /resolveIndexedDocumentCandidateFromDb\(db, candidate\)/)
  assert.match(fileManagementTools, /else \{[\s\S]*assertInsideWorkspace\(path, engine\)/)
  assert.match(fileManagementTools, /else \{[\s\S]*engine\.indexDocument\(guard\.root, path\)/)
})

test('file_locate normalizes user-facing file mention wrappers before lookup', () => {
  const fileManagementTools = readWorkspaceFile('src/main/modules/tools/file-management-tools.ts')
  const fileLocatePath = readWorkspaceFile('src/main/modules/tools/file-locate-path.ts')

  assert.match(fileManagementTools, /function buildFileLocatePathCandidates\(input: string\)/)
  assert.ok(fileManagementTools.includes('stripped.match(/^@?\\[([^\\]]+)\\]$/)'))
  assert.match(fileManagementTools, /fileURLToPath\(candidate\)/)
  assert.match(fileManagementTools, /decodeURIComponent\(value\)/)
  assert.match(fileManagementTools, /resolveIndexedDocumentCandidateFromDb\(db, candidate\)/)
  assert.match(fileLocatePath, /WHERE \(\? = 1 AND name = \?\)/)
  assert.match(fileLocatePath, /path LIKE \? ESCAPE/)
})
