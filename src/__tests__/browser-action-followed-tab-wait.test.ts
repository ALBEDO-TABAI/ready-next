import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import {
  ACTION_FOLLOWED_TAB_WINDOW_MS,
  snapshotBrowserTabs,
  waitForActionFollowedTab,
} from '../main/modules/tools/browser-act-shared'

interface Tab { id: string; title: string; url: string; active: boolean }

const SOURCE: Tab = { id: 'tab-source', title: 'Results', url: 'https://example.test/results', active: true }

/**
 * A controller whose page goes quiet (or never does) after a set delay, and which may bring up a tab of its own.
 * Real timers: the waits under test are short and bounded.
 */
function createController(options: {
  quietAfterMs?: number | null
  quietFails?: boolean
  withoutQuietSignal?: boolean
  newTabAfterMs?: number
}) {
  const startedAt = Date.now()
  const tabs: Tab[] = [{ ...SOURCE }]
  const switched: string[] = []
  let quietWaitAborted = false
  let quietWaitCalls = 0
  if (options.newTabAfterMs !== undefined) {
    setTimeout(() => {
      tabs.push({ id: 'tab-new', title: 'Opened by the click', url: 'https://example.test/detail', active: false })
    }, options.newTabAfterMs)
  }
  const controller = {
    getTabList: () => tabs.map((tab) => ({ ...tab })),
    switchTab: (tabId: string) => { switched.push(tabId); return { success: true } },
    // The followed tab is ready at once.
    executeJS: async () => ({ readyState: 'complete', bodyTextLen: 12, matched: false }),
    ...(options.withoutQuietSignal ? {} : {
      waitForCondition: (
        _tabId: string | null,
        condition: { condition: string; timeoutMs?: number },
        signal?: AbortSignal,
      ) => {
        quietWaitCalls += 1
        assert.equal(condition.condition, 'network_idle')
        if (options.quietFails) return Promise.reject(new Error('network_tracking_unavailable'))
        return new Promise<{ matched: boolean; elapsedMs: number }>((resolve, reject) => {
          const timer = options.quietAfterMs === null || options.quietAfterMs === undefined
            ? null
            : setTimeout(() => resolve({ matched: true, elapsedMs: Date.now() - startedAt }), options.quietAfterMs)
          signal?.addEventListener('abort', () => {
            quietWaitAborted = true
            if (timer) clearTimeout(timer)
            reject(new Error('aborted'))
          }, { once: true })
        })
      },
    }),
  } as unknown as BrowserController
  return {
    controller,
    switched,
    quietWaitAborted: () => quietWaitAborted,
    quietWaitCalls: () => quietWaitCalls,
  }
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = Date.now()
  const value = await run()
  return { value, ms: Date.now() - startedAt }
}

describe('waiting for a tab an action opened', () => {
  it('ends as soon as the page has gone quiet instead of waiting out the whole window', async () => {
    const fake = createController({ quietAfterMs: 300 })
    const before = snapshotBrowserTabs(fake.controller)

    const { value, ms } = await timed(() => waitForActionFollowedTab(fake.controller, SOURCE.id, before))

    assert.equal(value, null)
    assert.ok(ms >= 250 && ms < 1_200, `expected to stop shortly after the page went quiet, took ${ms} ms`)
    assert.equal(fake.quietWaitCalls(), 1)
  })

  it('follows a tab that appears while it waits, and stops watching the page', async () => {
    const fake = createController({ quietAfterMs: null, newTabAfterMs: 200 })
    const before = snapshotBrowserTabs(fake.controller)

    const { value, ms } = await timed(() => waitForActionFollowedTab(fake.controller, SOURCE.id, before))

    assert.equal(value?.tabId, 'tab-new')
    assert.equal(value?.reason, 'new_tab')
    assert.equal(value?.sourceTabId, SOURCE.id)
    assert.equal(value?.ready, true)
    assert.deepEqual(fake.switched, ['tab-new'])
    assert.ok(ms < 1_500, `took ${ms} ms`)
    assert.equal(fake.quietWaitAborted(), true, 'the quiet watch does not keep polling the page after the wait is over')
  })

  it('a tab that appears just as the page goes quiet is still followed', async () => {
    const fake = createController({ quietAfterMs: 150, newTabAfterMs: 100 })
    const before = snapshotBrowserTabs(fake.controller)
    const followed = await waitForActionFollowedTab(fake.controller, SOURCE.id, before)
    assert.equal(followed?.tabId, 'tab-new')
  })

  it('keeps the whole window when the page never goes quiet', async () => {
    const fake = createController({ quietAfterMs: null })
    const before = snapshotBrowserTabs(fake.controller)

    const { value, ms } = await timed(() => waitForActionFollowedTab(fake.controller, SOURCE.id, before, undefined, 700))

    assert.equal(value, null)
    assert.ok(ms >= 650, `must not return early without the quiet signal, took ${ms} ms`)
  })

  it('keeps the whole window when the quiet signal is unavailable or missing', async () => {
    for (const options of [{ quietFails: true }, { withoutQuietSignal: true }]) {
      const fake = createController(options)
      const before = snapshotBrowserTabs(fake.controller)
      const { value, ms } = await timed(() => waitForActionFollowedTab(fake.controller, SOURCE.id, before, undefined, 600))
      assert.equal(value, null)
      assert.ok(ms >= 550, `took ${ms} ms`)
    }
  })

  it('never waits longer than the window it always had', () => {
    assert.equal(ACTION_FOLLOWED_TAB_WINDOW_MS, 2600)
  })

  it('does not wait at all when there was no tab list to compare against', async () => {
    const fake = createController({ quietAfterMs: null })
    const { value, ms } = await timed(() => waitForActionFollowedTab(fake.controller, SOURCE.id, []))
    assert.equal(value, null)
    assert.ok(ms < 50)
    assert.equal(fake.quietWaitCalls(), 0)
  })

  it('stops when the turn is cancelled', async () => {
    const fake = createController({ quietAfterMs: null })
    const before = snapshotBrowserTabs(fake.controller)
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(), 120)
    await assert.rejects(waitForActionFollowedTab(fake.controller, SOURCE.id, before, cancel.signal))
    assert.equal(fake.quietWaitAborted(), true)
  })
})
