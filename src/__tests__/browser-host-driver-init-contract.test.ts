import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { BROWSER_HOST_KIND } from '../main/modules/browser-engine/host-types'

test('browser runtime has one rounded-capable host driver with no legacy selector', () => {
  const controller = readFileSync(new URL('../main/modules/browser-engine/ipc-handler.ts', import.meta.url), 'utf8')
  const layout = readFileSync(new URL('../main/modules/browser-engine/host-layout-service.ts', import.meta.url), 'utf8')

  assert.equal(BROWSER_HOST_KIND, 'webContentsView')
  assert.doesNotMatch(controller, /READY_BROWSER_HOST_DRIVER|browser_host_driver/)
  assert.doesNotMatch(layout, /\bBrowserView\b|addBrowserView|removeBrowserView/)
  assert.match(layout, /new WebContentsView\(options\)/)
  assert.match(layout, /view\.setBorderRadius\(HOST_BORDER_RADIUS\)/)
})
