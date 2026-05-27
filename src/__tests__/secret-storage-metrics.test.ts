import assert from 'node:assert/strict'
import test from 'node:test'

test('decryptChannelConfig emits a metric when encrypted secret decrypt falls back to raw', async () => {
  const { __setMetricSinkForTests } = await import('../main/modules/agent-control/metrics')
  const { TOOL_ERROR_METRICS } = await import('../main/modules/agent-control/tools-runtime/tool-error-metrics')
  const { decryptChannelConfig, __setSafeStorageForTests } = await import('../main/modules/agent-control/memory/secret-storage')
  const events: Array<Record<string, unknown>> = []
  __setMetricSinkForTests((event) => events.push(event))
  __setSafeStorageForTests({
    isEncryptionAvailable: () => true,
    encryptString: (raw: string) => Buffer.from(String(raw)),
    decryptString: () => {
      const error = new Error('decrypt failed') as Error & { code: string }
      error.code = 'ERR_DECRYPT'
      throw error
    },
  })
  try {
    const result = decryptChannelConfig({ token: '__enc__AAAA', label: 'visible' })

    assert.equal(result.token, '__enc__AAAA')
    assert.equal(result.label, 'visible')
    const event = events.find((item) => item.metric === TOOL_ERROR_METRICS.secretDecryptFailed)
    assert.ok(event)
    assert.equal(event.key, 'token')
    assert.match(String(event.errorKind), /^(ERR_DECRYPT|decrypt_unavailable)$/)
  } finally {
    __setSafeStorageForTests(null)
    __setMetricSinkForTests(null)
  }
})
