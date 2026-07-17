import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runBrowserCollection } from '../main/modules/browser-engine/browser-collector-engine'
import { parseCollectionPlan } from '../main/modules/browser-engine/agent-collection-plan'
import type { NoteCollectFacade } from '../main/modules/browser-engine/browser-collector-actions'

const join = (...parts: string[]) => parts.join('/')
const okImages = JSON.stringify({ count: 1, images: [{ url: 'https://img.xhscdn.com/retry.jpg' }] })

function fixedClock(): () => number {
  let t = 1_000
  return () => (t += 1_000)
}

function planOf(urls: string[]) {
  const parsed = parseCollectionPlan({
    targetProfileUrl: 'https://www.xiaohongshu.com/user/profile/retry',
    notes: urls.map((url, index) => ({ url, title: `笔记${index + 1}` })),
    outputRootDir: '/out',
    stopConditions: { maxConsecutiveFailures: 10 },
  })
  if (!parsed.ok) throw new Error(parsed.issues.join('; '))
  return parsed.plan
}

function facadeWithNavigationFailures(failUntil: Map<string, number>): {
  facade: NoteCollectFacade
  attemptsByUrl: Map<string, number>
} {
  const attemptsByUrl = new Map<string, number>()
  let currentUrl = ''
  return {
    attemptsByUrl,
    facade: {
      run: async (tool, args = {}) => {
        if (tool === 'browser_navigate') {
          currentUrl = String(args.url || '')
          const attempts = (attemptsByUrl.get(currentUrl) || 0) + 1
          attemptsByUrl.set(currentUrl, attempts)
          if (attempts <= (failUntil.get(currentUrl) || 0)) {
            return JSON.stringify({ ok: false, errorCode: 'navigation_failed', message: 'temporary navigation failure' })
          }
          return JSON.stringify({ ok: true })
        }
        if (tool === 'browser_read') return `详情页 ${currentUrl}`
        if (tool === 'browser_collect') return okImages
        if (tool === 'browser_download') return JSON.stringify({ success: 1 })
        return JSON.stringify({ ok: true })
      },
    },
  }
}

describe('collection item retry ledger', () => {
  it('retries retryable item failures at the final pass and keeps terminal attempts in the ledger', async () => {
    const urls = Array.from({ length: 5 }, (_, index) => `https://www.xiaohongshu.com/note/retry-${index}`)
    const retryThenSuccess = urls[1]
    const retryStillFails = urls[3]
    const { facade, attemptsByUrl } = facadeWithNavigationFailures(new Map([
      [retryThenSuccess, 1],
      [retryStillFails, 3],
    ]))
    const retryCursorSnapshots: string[][] = []

    const result = await runBrowserCollection(planOf(urls), {
      facade,
      pathJoin: join,
      now: fixedClock(),
      onCheckpoint: (state) => {
        const retryCursor = Array.isArray((state as { retryCursor?: unknown }).retryCursor)
          ? (state as { retryCursor: string[] }).retryCursor
          : []
        if (retryCursor.length > 0) retryCursorSnapshots.push(retryCursor.slice())
      },
    })

    assert.equal(result.stopReason, 'completed')
    assert.equal(result.collected.length, 4)
    assert.equal(result.failed.length, 1)
    assert.equal(attemptsByUrl.get(retryThenSuccess), 2)
    assert.equal(attemptsByUrl.get(retryStillFails), 3)
    assert.deepEqual(retryCursorSnapshots[0]?.sort(), [retryThenSuccess, retryStillFails].sort())
    assert.deepEqual((result.state as { failures?: unknown }).failures, [
      { url: retryStillFails, reason: 'navigate:navigation_failed', attempts: 3, retryable: true },
    ])
    assert.deepEqual(result.failed, [
      { url: retryStillFails, reason: 'navigate:navigation_failed', attempts: 3, retryable: true },
    ])
  })
})
