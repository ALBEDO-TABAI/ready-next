import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'

import { BrowserCollectionConsentStore } from '../main/modules/browser-engine/browser-collection-consent'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-collection-consent-store declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-collection-consent-store transitive sqlite load')
})

function createRepositoryMock() {
  const settings = new Map<string, string>()
  return {
    settings,
    repository: {
      getSetting: (key: string) => settings.get(key),
      setSetting: (key: string, value: string) => {
        settings.set(key, value)
      },
      deleteSetting: (key: string) => {
        settings.delete(key)
      },
      getAllSettings: () => Object.fromEntries(settings.entries()),
    },
  }
}

describe('BrowserCollectionConsentStore', () => {
  it('deleteByScope removes confirmed and pending consent records for only that scope', () => {
    const { settings, repository } = createRepositoryMock()
    const store = new BrowserCollectionConsentStore(repository as never)

    const keepPending = store.createPendingRequest({
      scopeId: 'scope-keep',
      sourceTaskId: 'source-keep',
      consentKind: 'partial_collection',
    })
    const deletePendingConfirmed = store.createPendingRequest({
      scopeId: 'scope-delete',
      sourceTaskId: 'source-delete',
      consentKind: 'partial_collection',
    })
    const deletePendingOpen = store.createPendingRequest({
      scopeId: 'scope-delete',
      sourceTaskId: 'source-delete-open',
      consentKind: 'partial_collection',
    })
    assert.ok(store.confirmPendingRequest(deletePendingConfirmed.requestId, 'ui_action'))

    const removed = store.deleteByScope('scope-delete')

    assert.ok(removed >= 3)
    assert.equal(store.readPendingRequest(deletePendingConfirmed.requestId), null)
    assert.equal(store.readPendingRequest(deletePendingOpen.requestId), null)
    assert.equal(store.hasConsent('partial_collection', 'scope-delete', 'source-delete'), false)
    assert.ok(store.readPendingRequest(keepPending.requestId))
    assert.equal(settings.size, 2, 'only the keep-scope pending row and index should remain')
  })
})
