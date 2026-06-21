import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTION_CONFIRMATION_ERROR_KINDS,
  isRegisteredErrorKind,
  lookupErrorKindMeta,
} from '../main/modules/agent-control/contracts/error-kinds'

test('action confirmation errorKinds are registered in runtime helpers', () => {
  for (const meta of Object.values(ACTION_CONFIRMATION_ERROR_KINDS)) {
    assert.equal(isRegisteredErrorKind(meta.code), true, `${meta.code} should be registered`)
    assert.deepEqual(lookupErrorKindMeta(meta.code), meta)
  }
})
