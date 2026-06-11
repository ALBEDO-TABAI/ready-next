/**
 * EP2-I2 — negation three-layer deepening: family extension (05 §3 action
 * list), explicit release signals, session-lineage state, dispatch-layer
 * interception, and gate ordering (拒绝权优先于确认权 — a negated call dies
 * as denied_by_user_negation, never as pending_confirmation, and freezes
 * nothing).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { detectNegations, detectNegationReleases } from '../shared/agent-followup-intent'
import {
  recordNegations,
  releaseNegations,
  activeNegations,
  matchToolNegationFamily,
  __clearNegationStateForTests,
} from '../main/modules/agent-control/safety/negation-state'
import { executeToolCall } from '../main/modules/tools/tool-executor'

const NO_AUTH = { mode: 'none', reason: 'no_skill_turn' } as never

test('family extension matrix: deletion / external_send / overwrite join collection', () => {
  assert.deepEqual(detectNegations('不要删除这些文件'), ['deletion'])
  assert.deepEqual(detectNegations('先不要发送邮件'), ['external_send'])
  assert.deepEqual(detectNegations('别覆盖原文'), ['overwrite'])
  assert.deepEqual(detectNegations('不要采集，只看看'), ['collection'])
  assert.deepEqual(detectNegations('把这段删除一下'), [], 'no negation token → no family')
})

test('release signals lift standing negations; negated sentences never release', () => {
  assert.deepEqual(detectNegationReleases('现在可以采集了'), ['collection'])
  assert.deepEqual(detectNegationReleases('可以发送了'), ['external_send'])
  assert.deepEqual(detectNegationReleases('不要采集'), [], 'a negation is not a release')
  assert.deepEqual(detectNegationReleases('继续看看'), [], 'release requires a family verb nearby')
})

test('session-lineage state: record persists across turns until explicit release', () => {
  __clearNegationStateForTests()
  recordNegations('scope-a', ['collection'])
  assert.deepEqual(activeNegations('scope-a'), ['collection'])
  assert.deepEqual(activeNegations('scope-b'), [], 'scoped — no cross-lineage leak')
  releaseNegations('scope-a', ['collection'])
  assert.deepEqual(activeNegations('scope-a'), [])
})

test('tool-family mapping is conservative by name', () => {
  assert.equal(matchToolNegationFamily('browser_visible_collect', ['collection']), 'collection')
  assert.equal(matchToolNegationFamily('browser_open_url', ['collection']), null, 'open is not collection')
  assert.equal(matchToolNegationFamily('browser_open_url', ['browser']), 'browser')
  assert.equal(matchToolNegationFamily('feishu_message_send', ['external_send']), 'external_send')
  assert.equal(matchToolNegationFamily('document_save_tab', ['deletion', 'overwrite']), null)
})

test('dispatch layer: negated collection call returns denied_by_user_negation (second layer of the double net)', async () => {
  const output = await executeToolCall('browser_visible_collect', { url: 'https://x' }, {
    activeNegations: ['collection'],
    sessionId: 'scope-neg',
    authorization: NO_AUTH,
  } as never)
  const data = output.data as { errorKind?: string; family?: string }
  assert.equal(data.errorKind, 'denied_by_user_negation')
  assert.equal(data.family, 'collection')
  assert.equal(output.envelope?.kind, 'denied_by_policy', 'envelope maps the negation denial to denied_by_policy')
})

test('gate ordering: a negated M2-class call dies as negation denial, never pending_confirmation, freezing nothing', async () => {
  // feishu_send_message is external_send (M2/M3 territory in the confirmation
  // table). With a standing external_send negation the call must be rejected
  // by the negation layer BEFORE the confirmation gate runs.
  const output = await executeToolCall('feishu_message_send', { channel_id: 'primary', chat_id: 'oc_1', content: { text: '敏感' }, msg_type: 'text' }, {
    activeNegations: ['external_send'],
    sessionId: 'scope-neg-2',
    authorization: NO_AUTH,
  } as never)
  const data = output.data as { errorKind?: string }
  assert.equal(data.errorKind, 'denied_by_user_negation')
  assert.notEqual(data.errorKind, 'denied_pending_confirmation')
})

test('host invoker and released state pass the negation layer', async () => {
  __clearNegationStateForTests()
  // host bypass: the user acting is not the model — interception skipped
  // (the call proceeds into normal dispatch and fails later for unrelated
  // infra reasons, NOT with a negation denial).
  const hostOutput = await executeToolCall('browser_visible_collect', {}, {
    activeNegations: ['collection'],
    invoker: 'host',
    authorization: NO_AUTH,
  } as never)
  const hostData = (hostOutput.data ?? {}) as { errorKind?: string }
  assert.notEqual(hostData.errorKind, 'denied_by_user_negation')

  // released: empty negation list → layer inert
  const releasedOutput = await executeToolCall('browser_visible_collect', {}, {
    activeNegations: [],
    authorization: NO_AUTH,
  } as never)
  const releasedData = (releasedOutput.data ?? {}) as { errorKind?: string }
  assert.notEqual(releasedData.errorKind, 'denied_by_user_negation')
})
