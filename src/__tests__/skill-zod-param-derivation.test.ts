/**
 * Verifies zodObjectToParamList invariants.
 *
 * Phase 4: the 6 control-tool round-trip cases were removed along with
 * SKILL_CONTROL_SCHEMAS and EXECUTION_TOOL_DEFS. The generic fail-loud case
 * (a .describe()-less field must throw) is retained because
 * `paramListToZodObject` / `zodObjectToParamList` round-trip is still used
 * for the 4 skill primitives + dynamic skill-action schemas.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'

import { zodObjectToParamList } from '../main/modules/tools/zod-param-derivation'

test('zodObjectToParamList fails loud when a field lacks .describe()', () => {
  const badSchema = z.object({
    missingDescription: z.string(),
  })
  assert.throws(
    () => zodObjectToParamList(badSchema),
    /missing \.describe\(\)/,
  )
})
