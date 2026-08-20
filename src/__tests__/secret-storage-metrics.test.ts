import assert from 'node:assert/strict'
import test from 'node:test'

test('legacy encrypted channel secrets fail closed instead of returning ciphertext', async () => {
  const { __setMetricSinkForTests } = await import('../main/modules/agent-control/metrics')
  const { TOOL_ERROR_METRICS } = await import('../main/modules/agent-control/tools-runtime/tool-error-metrics')
  const { decryptChannelConfig } = await import('../main/modules/agent-control/memory/secret-storage')
  const events: Array<Record<string, unknown>> = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const result = decryptChannelConfig({ token: '__enc__AAAA', label: 'visible' }, 'channel:test')

    assert.equal(result.token, '')
    assert.equal(result.label, 'visible')
    const event = events.find((item) => item.metric === TOOL_ERROR_METRICS.secretDecryptFailed)
    assert.ok(event)
    assert.equal(event.key, 'token')
    assert.equal(event.errorKind, 'legacy_secret_unavailable')
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('new channel secrets use an owner-bound vault handle and never return across owners', async () => {
  const { decryptChannelConfig, prepareChannelConfigUpdate } = await import('../main/modules/agent-control/memory/secret-storage')
  const prepared = await prepareChannelConfigUpdate({ token: 'channel-secret', label: 'visible' }, 'channel:one')
  const sealed = prepared.config

  assert.doesNotMatch(JSON.stringify(sealed), /channel-secret/)
  assert.match(String(sealed.token || ''), /^__ready_credential_v1__/)
  assert.equal(decryptChannelConfig(sealed, 'channel:one').token, 'channel-secret')
  assert.equal(decryptChannelConfig(sealed, 'channel:two').token, '')
  await prepared.commit()
})
