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
  // Fallback shape re-anchored: f8ea13a6 added the explicit workspace-roots
  // third argument (honor file manager roots) — behavior unchanged: a path
  // missing from the index still falls back to the workspace guard and gets
  // indexed on demand instead of erroring out.
  assert.match(
    fileManagementTools,
    /if \(!row\) \{[\s\S]{0,200}?assertInsideWorkspace\(path, engine, context\?\.workspaceRoots\)/,
  )
  assert.match(
    fileManagementTools,
    /if \(!row\) \{[\s\S]{0,400}?engine\.indexDocument\(guard\.root, path\)/,
  )
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
