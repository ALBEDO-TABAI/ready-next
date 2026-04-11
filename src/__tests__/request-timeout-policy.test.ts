import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveApiRequestTimeoutMs } from '../main/modules/claude-bridge/request-timeout-policy'

describe('request timeout policy', () => {
  it('keeps the default timeout for regular requests', () => {
    assert.equal(resolveApiRequestTimeoutMs(), 45_000)
  })

  it('gives kimi coding tool requests the longer timeout budget', () => {
    assert.equal(resolveApiRequestTimeoutMs(undefined, {
      baseUrl: 'https://api.kimi.com/coding',
    }), 90_000)
  })

  it('extends widget update requests beyond the default timeout', () => {
    assert.equal(resolveApiRequestTimeoutMs({
      forceDocumentTool: true,
      documentWidgetTaskKind: 'update',
    }), 90_000)
  })

  it('extends generic document tool requests moderately', () => {
    assert.equal(resolveApiRequestTimeoutMs({
      forceDocumentTool: true,
      documentWidgetTaskKind: null,
    }, {
      baseUrl: 'https://api.anthropic.com',
    }), 75_000)
  })

  it('keeps kimi coding tool requests on the longer budget even for generic document flows', () => {
    assert.equal(resolveApiRequestTimeoutMs({
      forceDocumentTool: true,
      documentWidgetTaskKind: null,
    }, {
      baseUrl: 'https://api.kimi.com/coding',
    }), 90_000)
  })
})
