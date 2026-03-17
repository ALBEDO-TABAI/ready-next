import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { buildScopedWidgetInlineScript } from '../renderer/components/document/widget-dom-script-runtime'

describe('widget dom runtime script scoping', () => {
  it('allows repeated execution of widget scripts with top-level const declarations', () => {
    const script = buildScopedWidgetInlineScript(
      `
const stockData = [1, 2, 3]
function calculateReturn() {
  return stockData.length
}
window.__last = calculateReturn()
`,
      new Set(['calculateReturn']),
    )

    const context = {
      window: {} as Record<string, unknown>,
    }

    vm.runInNewContext(script, context)
    vm.runInNewContext(script, context)

    assert.equal(typeof context.window.calculateReturn, 'function')
    assert.equal(context.window.__last, 3)
  })
})
