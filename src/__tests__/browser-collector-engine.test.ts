import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runBrowserCollection } from '../main/modules/browser-engine/browser-collector-engine'
import { parseCollectionPlan, createCollectionLoopState, recordNoteResult } from '../main/modules/browser-engine/agent-collection-plan'
import type { NoteCollectFacade } from '../main/modules/browser-engine/browser-collector-actions'

const join = (...parts: string[]) => parts.join('/')

function planOf(noteCount: number) {
  const parsed = parseCollectionPlan({
    targetProfileUrl: 'https://www.xiaohongshu.com/user/profile/abc',
    notes: Array.from({ length: noteCount }, (_, i) => ({ url: `https://www.xiaohongshu.com/note/${i}`, title: `笔记${i}` })),
    outputRootDir: '/out',
  })
  if (!parsed.ok) throw new Error(parsed.issues.join('; '))
  return parsed.plan
}

const okImages = JSON.stringify({ count: 1, images: [{ url: 'https://img.xhscdn.com/a.jpg' }] })

function fixedClock(): () => number {
  let t = 1_000
  return () => (t += 1000)
}

function facadeAlwaysOk(): NoteCollectFacade {
  return {
    run: async (tool) => {
      if (tool === 'browser_collect_images') return okImages
      if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
      return JSON.stringify({ ok: true })
    },
  }
}

describe('runBrowserCollection (background per-note loop)', () => {
  it('collects every note, checkpoints after each, and stops as completed', async () => {
    const plan = planOf(3)
    const checkpoints: number[] = []
    const res = await runBrowserCollection(plan, {
      facade: facadeAlwaysOk(),
      pathJoin: join,
      now: fixedClock(),
      onCheckpoint: (state) => { checkpoints.push(state.collected.length + state.failed.length) },
    })
    assert.equal(res.stopReason, 'completed')
    assert.equal(res.collected.length, 3)
    assert.equal(res.failed.length, 0)
    assert.equal(res.rounds, 3)
    assert.deepEqual(checkpoints, [1, 2, 3], 'checkpoint after every note')
  })

  it('honours a cooperative shouldStop (cancel / lease loss) before the next note', async () => {
    const plan = planOf(5)
    let processed = 0
    const res = await runBrowserCollection(plan, {
      facade: {
        run: async (tool) => {
          if (tool === 'browser_navigate') processed += 1
          if (tool === 'browser_collect_images') return okImages
          if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
          return JSON.stringify({ ok: true })
        },
      },
      pathJoin: join,
      now: fixedClock(),
      // stop after 2 notes are done
      shouldStop: () => (processed >= 2 ? 'cancelled' : null),
    })
    assert.equal(res.stopReason, 'cancelled')
    assert.ok(res.collected.length <= 2)
  })

  it('stops with too_many_failures after the consecutive-failure threshold', async () => {
    const plan = planOf(20)
    const res = await runBrowserCollection(plan, {
      facade: {
        run: async (tool) => {
          if (tool === 'browser_navigate') return JSON.stringify({ ok: false, errorCode: 'navigation_failed', message: 'x' })
          return JSON.stringify({ ok: true })
        },
      },
      pathJoin: join,
      now: fixedClock(),
    })
    assert.equal(res.stopReason, 'too_many_failures')
    assert.equal(res.collected.length, 0)
    assert.ok(res.failed.length >= 5)
  })

  it('stops the whole collection when a note page needs verification', async () => {
    const plan = planOf(10)
    const navigated: string[] = []
    const res = await runBrowserCollection(plan, {
      facade: {
        run: async (tool, args) => {
          if (tool === 'browser_navigate') navigated.push(String(args?.url))
          if (tool === 'browser_read_page') return '请扫码登录后继续查看内容'
          if (tool === 'browser_collect_images') return okImages
          if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
          return JSON.stringify({ ok: true })
        },
      },
      pathJoin: join,
      now: fixedClock(),
    })
    assert.equal(res.stopReason, 'needs_verification')
    assert.equal(res.collected.length, 0)
    assert.equal(res.failed.length, 0)
    assert.equal(res.state.cursor, 0, 'verification pauses before advancing, so resume retries the same note')
    assert.equal(navigated.length, 1, 'must not continue through the frozen target list after a verification wall')
  })

  it('E2: a single under-collected carousel is a per-note partial — it does NOT halt the whole task', async () => {
    const plan = planOf(2)
    const imageUrl = 'https://sns-webpic-qc.xhscdn.com/notes_pre_post/image-1!nc_n_webp_mw_1'
    const res = await runBrowserCollection(plan, {
      facade: {
        run: async (tool, args) => {
          if (tool === 'browser_collect_images') {
            return JSON.stringify({
              count: 1,
              scope: 'xiaohongshu-detail',
              expectedImageCount: 10,
              images: [{ url: imageUrl, width: 1200, height: 1600 }],
            })
          }
          if (tool === 'browser_extract_structured' && args?.template === 'image_gallery') {
            return JSON.stringify({ items: [{ link: imageUrl, media: [imageUrl] }] })
          }
          if (tool === 'browser_download_urls') {
            throw new Error('under-collected carousel must not download')
          }
          return JSON.stringify({ ok: true })
        },
      },
      pathJoin: join,
      now: fixedClock(),
    })

    // E2 fix: an under-count on one note no longer escalates the whole collection
    // to needs_verification/waiting_human; the task runs to completion and the
    // partial note is recorded as a retryable per-note failure (verdict decides).
    assert.notEqual(res.stopReason, 'needs_verification', 'under-count must not halt the task')
    assert.equal(res.collected.length, 0)
    assert.ok(res.failed.length >= 1, 'under-collected note recorded as a per-note failure')
    assert.ok(res.failed.every((f) => String(f.reason).startsWith('partial_images')), 'reason is partial_images')
    assert.ok(res.failed.every((f) => f.retryable === true), 'partial_images is retryable, not a permanent loss')
  })

  it('paces between notes (not before the first) on high-control platforms', async () => {
    const plan = planOf(3)
    const sleeps: number[] = []
    const res = await runBrowserCollection(plan, {
      facade: facadeAlwaysOk(),
      pathJoin: join,
      now: fixedClock(),
      interNoteDelayMs: 1500,
      sleep: async (ms) => { sleeps.push(ms) },
    })
    assert.equal(res.stopReason, 'completed')
    assert.deepEqual(sleeps, [1500, 1500], 'paces before notes 2 and 3, not before note 1')
  })

  it('stops with max_images once the download-volume budget is exhausted', async () => {
    const plan = planOf(10)
    // Each note saves 3 images; a budget of 5 should stop after the 2nd note
    // (6 images > 5), having collected at most a couple notes.
    const res = await runBrowserCollection(plan, {
      facade: {
        run: async (tool) => {
          if (tool === 'browser_collect_images') return JSON.stringify({ count: 3, images: [{ url: 'https://img/a.jpg' }, { url: 'https://img/b.jpg' }, { url: 'https://img/c.jpg' }] })
          if (tool === 'browser_download_urls') return JSON.stringify({ success: 3 })
          return JSON.stringify({ ok: true })
        },
      },
      pathJoin: join,
      now: fixedClock(),
      maxTotalImages: 5,
    })
    assert.equal(res.stopReason, 'max_images')
    assert.ok(res.collected.length >= 1 && res.collected.length < 10, 'stops before exhausting all notes')
  })

  it('does not pace when interNoteDelayMs is 0 / unset', async () => {
    const plan = planOf(3)
    const sleeps: number[] = []
    await runBrowserCollection(plan, {
      facade: facadeAlwaysOk(),
      pathJoin: join,
      now: fixedClock(),
      sleep: async (ms) => { sleeps.push(ms) },
    })
    assert.deepEqual(sleeps, [], 'no pacing without a delay')
  })

  it('resumes from a prior checkpoint state instead of restarting', async () => {
    const plan = planOf(4)
    // Simulate the first two notes already collected (a prior run / checkpoint).
    let state = createCollectionLoopState(1)
    state = recordNoteResult(state, plan.notes[0], { success: true })
    state = recordNoteResult(state, plan.notes[1], { success: true })

    const navigated: string[] = []
    const res = await runBrowserCollection(
      plan,
      {
        facade: {
          run: async (tool, args) => {
            if (tool === 'browser_navigate') navigated.push(String(args?.url))
            if (tool === 'browser_collect_images') return okImages
            if (tool === 'browser_download_urls') return JSON.stringify({ success: 1 })
            return JSON.stringify({ ok: true })
          },
        },
        pathJoin: join,
        now: fixedClock(),
      },
      state,
    )
    assert.equal(res.stopReason, 'completed')
    assert.equal(res.collected.length, 4, 'two prior + two new')
    assert.deepEqual(navigated, ['https://www.xiaohongshu.com/note/2', 'https://www.xiaohongshu.com/note/3'], 'only the un-collected notes are re-run')
  })
})
