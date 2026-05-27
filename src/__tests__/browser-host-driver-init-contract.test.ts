import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBrowserHostKindFromConfig } from '../main/modules/browser-engine/host-kind-config'

test('browser host driver honors persisted setting when env override is absent', () => {
  assert.equal(resolveBrowserHostKindFromConfig(undefined, () => 'browserView'), 'browserView')
  assert.equal(resolveBrowserHostKindFromConfig(undefined, () => 'webContentsView'), 'webContentsView')
})

test('browser host driver env override wins over persisted setting and invalid values default safely', () => {
  assert.equal(resolveBrowserHostKindFromConfig('webcontentsview', () => 'browserView'), 'webContentsView')
  assert.equal(resolveBrowserHostKindFromConfig('browserview', () => 'webContentsView'), 'browserView')
  assert.equal(resolveBrowserHostKindFromConfig(undefined, () => 'bogus'), 'webContentsView')
  assert.equal(resolveBrowserHostKindFromConfig(undefined, () => { throw new Error('settings unavailable') }), 'webContentsView')
})
