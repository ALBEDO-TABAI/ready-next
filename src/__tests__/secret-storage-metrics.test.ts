import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return {
        url: [
          'data:text/javascript,',
          'export const app={getPath:()=>"/tmp/ready-secret-storage-test"};',
          'export const safeStorage={',
          'isEncryptionAvailable:()=>true,',
          'encryptString:(raw)=>Buffer.from(String(raw)),',
          'decryptString:()=>{const error=new Error("decrypt failed"); error.code="ERR_DECRYPT"; throw error;}',
          '};',
        ].join(''),
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})

test('decryptChannelConfig emits a metric when encrypted secret decrypt falls back to raw', async () => {
  const { __setMetricSinkForTests } = await import('../main/modules/agent-control/metrics')
  const { TOOL_ERROR_METRICS } = await import('../main/modules/agent-control/tools-runtime/tool-error-metrics')
  const { decryptChannelConfig } = await import('../main/modules/agent-control/memory/secret-storage')
  const events: Array<Record<string, unknown>> = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const result = decryptChannelConfig({ token: '__enc__AAAA', label: 'visible' })

    assert.equal(result.token, '__enc__AAAA')
    assert.equal(result.label, 'visible')
    const event = events.find((item) => item.metric === TOOL_ERROR_METRICS.secretDecryptFailed)
    assert.ok(event)
    assert.equal(event.key, 'token')
    assert.equal(event.errorKind, 'ERR_DECRYPT')
  } finally {
    __setMetricSinkForTests(null)
  }
})
