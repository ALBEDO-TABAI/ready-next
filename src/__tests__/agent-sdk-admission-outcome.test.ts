import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBeginRunRejection } from '../main/modules/agent-control/runtime-core/agent-sdk-admission-outcome'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('agent-sdk-admission-outcome declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent-sdk-admission-outcome transitive sqlite load')
})

test('begin-run admission outcomes keep caller and ledger statuses aligned', () => {
  assert.deepEqual(resolveBeginRunRejection('superseded'), {
    status: 'cancelled',
    terminalReason: 'cancelled_runtime',
    cancelled: true
  })
  assert.deepEqual(resolveBeginRunRejection('orphan_limit'), {
    status: 'error',
    terminalReason: 'blocked_external',
    cancelled: false
  })
})
