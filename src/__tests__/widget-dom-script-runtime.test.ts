import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import {
  buildScopedWidgetInlineScript,
  invokeInlineHandlerExpression,
} from '../renderer/components/document/widget-dom-script-runtime'

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

  it('invokes simple inline handler expressions against the widget window scope', () => {
    let called = 0
    const widgetWindow = {
      calculateReturn: () => {
        called += 1
      },
    }

    const handled = invokeInlineHandlerExpression('calculateReturn()', widgetWindow, { type: 'input' })

    assert.equal(handled, true)
    assert.equal(called, 1)
  })

  it('supports the safe literal arguments commonly emitted by widget markup', () => {
    const calls: unknown[][] = []
    const widgetWindow = {
      switchTab: (...args: unknown[]) => calls.push(args),
    }
    const event = { type: 'click', target: { value: 'from-event' } }
    const target = { value: 'from-this' }

    assert.equal(invokeInlineHandlerExpression('switchTab(1)', widgetWindow, event, target), true)
    assert.equal(invokeInlineHandlerExpression("switchTab('overview')", widgetWindow, event, target), true)
    assert.equal(invokeInlineHandlerExpression('switchTab(event)', widgetWindow, event, target), true)
    assert.equal(invokeInlineHandlerExpression('switchTab(this.value)', widgetWindow, event, target), true)
    assert.deepEqual(calls, [[1], ['overview'], [event], ['from-this']])
    assert.equal(invokeInlineHandlerExpression('window.location="https://example.com"', widgetWindow, event, target), false)
  })
})
