import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_HOST_KIND } from '../main/modules/browser-engine/host-types'

// The rounded WebContentsView host and the absence of a BrowserView fallback are pinned by
// scripts/check-browser-surface-binding.cjs (verify:browser-surface).
test('browser runtime has one rounded-capable host kind', () => {
  assert.equal(BROWSER_HOST_KIND, 'webContentsView')
})
