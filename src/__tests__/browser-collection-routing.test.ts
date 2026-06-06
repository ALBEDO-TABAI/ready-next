import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  resolveHighControlCollectionTarget,
  resolveSourceCollectionTarget,
} from '../main/modules/browser-engine/collection-routing'

describe('browser collection routing', () => {
  it('routes high-control visible collection to the current profile tab', () => {
    const target = resolveHighControlCollectionTarget({
      highControl: true,
      activeTabId: 'tab-profile-1',
      activeTabUrl: 'https://www.xiaohongshu.com/user/profile/abc',
    })

    assert.deepEqual(target, {
      tabId: 'tab-profile-1',
      surface: 'user-view',
      usesVisibleTab: true,
    })
  })

  it('does not route ordinary collection to the visible tab helper', () => {
    const target = resolveHighControlCollectionTarget({
      highControl: false,
      activeTabId: 'tab-news-1',
      activeTabUrl: 'https://example.com/feed',
    })

    assert.equal(target, null)
  })

  it('inherits the visible source tab for high-control card_loop collection', () => {
    const target = resolveSourceCollectionTarget({
      highControl: true,
      sourcePayload: {
        tabId: 'tab-profile-1',
        surface: 'user-view',
      },
    })

    assert.deepEqual(target, {
      tabId: 'tab-profile-1',
      surface: 'user-view',
      usesVisibleTab: true,
    })
  })
})
