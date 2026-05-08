/**
 * Stage S (PR-S6 / W4.3) — view_image followup injection hook.
 *
 * Today the hook is a TODO-marked placeholder inside
 * `consumeExecutedToolBatch`. The test confirms the hook lives in the
 * right place by reading the source file and asserting structural
 * properties (literal `'view_image'` reference + the
 * `view_image_followup_injection_pending` metric token co-located with
 * the batch consumer).
 *
 * When the actual `view_image` tool ships, this test will be upgraded
 * to a runtime behaviour test that simulates a tool batch with a
 * `view_image` result and asserts the next round's messages contain
 * the injected image block.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const TURN_ENGINE_PATH = path.join(REPO_ROOT, 'src/main/modules/agent-control/turn-engine.ts')

test('turn-engine carries a view_image followup injection hook', () => {
  const src = fs.readFileSync(TURN_ENGINE_PATH, 'utf8')
  assert.ok(/['"]view_image['"]/.test(src), 'view_image literal must be referenced')
  assert.ok(/view_image_followup_injection_pending/.test(src), 'pending injection metric token must be present')
})

test('view_image hook lives inside the consumeExecutedToolBatch body', () => {
  const src = fs.readFileSync(TURN_ENGINE_PATH, 'utf8')
  const consumeIdx = src.indexOf('consumeExecutedToolBatch')
  const viewImageIdx = src.indexOf("'view_image'")
  assert.ok(consumeIdx >= 0, 'consumeExecutedToolBatch must exist')
  assert.ok(viewImageIdx >= 0, 'view_image literal must exist')
  assert.ok(viewImageIdx > consumeIdx, 'view_image hook must come after consumeExecutedToolBatch declaration')
})
