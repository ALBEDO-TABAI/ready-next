import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isRegisteredErrorKind,
  lookupErrorKindMeta,
  SPECIALIST_BLUEPRINT_ERROR_KINDS,
} from '../main/modules/agent-control/contracts/error-kinds'

test('specialist blueprint errorKinds are registered in runtime helpers', () => {
  for (const meta of Object.values(SPECIALIST_BLUEPRINT_ERROR_KINDS)) {
    assert.equal(isRegisteredErrorKind(meta.code), true, `${meta.code} should be registered`)
    assert.deepEqual(lookupErrorKindMeta(meta.code), meta)
  }
})
