/**
 * Stage R W6.4 — present_file path sandbox enforcement.
 *
 * Asserts that paths outside `<outputsRoot>` throw
 * `ToolDomainError('path_outside_outputs')` rather than silently leaking
 * arbitrary filesystem reads to the renderer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executePresentFile } from '../main/modules/tools/builtins/present-file'
import { ToolDomainError } from '../main/modules/tools/tool-errors'

test('executePresentFile rejects path outside outputsRoot', async () => {
  const outputsRoot = mkdtempSync(join(tmpdir(), 'present-file-test-'))
  await assert.rejects(
    () =>
      executePresentFile(
        { path: '/etc/passwd' },
        {
          outputsRoot,
          requestModuleToolAction: async () => ({}),
        },
      ),
    (err: unknown) => {
      assert.ok(err instanceof ToolDomainError, 'expected ToolDomainError')
      assert.equal((err as ToolDomainError).errorKind, 'path_outside_outputs')
      return true
    },
  )
})

test('executePresentFile accepts path inside outputsRoot', async () => {
  const outputsRoot = mkdtempSync(join(tmpdir(), 'present-file-ok-'))
  const target = join(outputsRoot, 'report.txt')
  writeFileSync(target, 'hello')

  let actionCalled = false
  const result = await executePresentFile(
    { path: target },
    {
      outputsRoot,
      requestModuleToolAction: async () => {
        actionCalled = true
        return {}
      },
    },
  )
  assert.equal(result.status, 'presented')
  assert.equal(actionCalled, true)
})
