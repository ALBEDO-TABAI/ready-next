import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('skill tools emit structured task projection patches for workflow executions', () => {
  const source = readWorkspaceFile('src/main/modules/tools/skills-tools.ts')

  assert.match(source, /createToolExecutionOutput/)
  assert.match(source, /function buildSkillProjectionPatch\(/)
  assert.match(source, /projectionPatch:\s*buildSkillProjectionPatch\(/)
  assert.match(source, /function toSkillInteractionHint\(/)
  assert.match(source, /interactionHint:\s*toSkillInteractionHint\(/)
})
