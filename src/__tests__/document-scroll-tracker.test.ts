import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { trackDocumentScrollPosition } from '../renderer/modules/document/documentScrollRuntime'

test('an immediate departure flushes the last scroll without reading hidden geometry', () => {
  const dom = new JSDOM('<div id="scroll"></div>')
  const element = dom.window.document.getElementById('scroll')!
  const originalWindow = globalThis.window
  globalThis.window = dom.window as unknown as Window & typeof globalThis
  let hidden = false
  let top = 240
  let saved = -1
  Object.defineProperties(element, {
    scrollTop: { get: () => { assert.equal(hidden, false); return top } },
    scrollHeight: { get: () => { assert.equal(hidden, false); return 1000 } },
    clientHeight: { get: () => { assert.equal(hidden, false); return 400 } },
  })
  try {
    const tracker = trackDocumentScrollPosition(element, () => '', (snapshot) => { saved = snapshot.top })
    element.dispatchEvent(new dom.window.Event('scroll'))
    hidden = true
    tracker.flush()
    tracker.dispose()
    assert.equal(saved, 240)
    hidden = false
    top = 0
    const next = trackDocumentScrollPosition(element, () => '', (snapshot) => { saved = snapshot.top })
    element.dispatchEvent(new dom.window.Event('scroll'))
    hidden = true
    next.dispose()
    assert.equal(saved, 0)
  } finally {
    globalThis.window = originalWindow
    dom.window.close()
  }
})
