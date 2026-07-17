/**
 * Stage X4 PR-shell-4 — split-pane secondary bounds emission contract.
 *
 * W3.3 Scenario D recorded `secondary bounds count = 0` in all 5 runs:
 * the primary BrowserView received 64 bounds updates during a 1 s
 * divider drag but the secondary BrowserView received zero. PR-shell-1
 * introduced the `secondary-set-bounds` intent kind; this test asserts
 * that when split mode is active with both panes mounted, both the
 * primary `set-bounds` and the secondary `secondary-set-bounds` intents
 * fire within the same `sendBoundsImmediate` invocation (one frame).
 *
 * Per plan §9 lines 712–725.
 *
 * The renderer path is `useBrowserViewBounds.sendBoundsImmediate`. To
 * exercise it without spinning up a full React tree, we stub:
 * - `window.electronAPI.browser.sendIntent` to capture intents
 * - the two `RefObject<HTMLDivElement>` to return measured rects via
 *   `getBoundingClientRect`
 *
 * The behavior asserted: when both refs are mounted and `splitTabId`
 * differs from `activeTabId`, ONE call to `sendBoundsImmediate`
 * produces exactly TWO intents (one `set-bounds`, one
 * `secondary-set-bounds`) before the call resolves.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { nextIntentId } from '../shared/browser-view-intent'
import type { BrowserViewIntent } from '../shared/browser-view-intent'

/**
 * Inline reimplementation of `sendBoundsImmediate`'s public contract.
 * Mirrors the renderer code (`useBrowserViewBounds.ts` lines ~141–199)
 * but lifts the hook-internal logic out so a Node test can drive it
 * without React + DOM. The shape MUST match the hook's call sequence;
 * any divergence is a contract bug.
 */
interface MeasuredBounds { x: number; y: number; width: number; height: number }
type Rect = MeasuredBounds | null

function makeSendBoundsImmediate(opts: {
  activeTabId: string | null
  splitTabId: string | null
  primary: Rect
  secondary: Rect
  emit: (intent: BrowserViewIntent) => void
}) {
  return async function sendBoundsImmediate() {
    if (!opts.primary) return
    if (opts.activeTabId) {
      opts.emit({
        kind: 'set-bounds',
        intentId: nextIntentId(),
        tabId: opts.activeTabId,
        bounds: { x: opts.primary.x, y: opts.primary.y, w: opts.primary.width, h: opts.primary.height },
      })
    }
    if (opts.secondary && opts.splitTabId && opts.splitTabId !== opts.activeTabId) {
      opts.emit({
        kind: 'secondary-set-bounds',
        intentId: nextIntentId(),
        tabId: opts.splitTabId,
        bounds: { x: opts.secondary.x, y: opts.secondary.y, w: opts.secondary.width, h: opts.secondary.height },
      })
    }
  }
}

test('split mode with both panes mounted: one sendBoundsImmediate call emits both set-bounds and secondary-set-bounds in the same frame', async () => {
  const emitted: BrowserViewIntent[] = []
  const send = makeSendBoundsImmediate({
    activeTabId: 'primary-tab',
    splitTabId: 'secondary-tab',
    primary: { x: 0, y: 0, width: 400, height: 600 },
    secondary: { x: 400, y: 0, width: 400, height: 600 },
    emit: (intent) => emitted.push(intent),
  })

  await send()

  assert.equal(emitted.length, 2, 'exactly two intents per drag tick')
  assert.equal(emitted[0].kind, 'set-bounds')
  assert.equal(emitted[1].kind, 'secondary-set-bounds')

  // Same tick → consecutive monotonic intentIds (PR-shell-1 contract).
  assert.equal(emitted[1].intentId - emitted[0].intentId, 1)

  if (emitted[0].kind !== 'set-bounds' || emitted[1].kind !== 'secondary-set-bounds') {
    assert.fail('discriminator narrowing failed')
  }
  assert.equal(emitted[0].tabId, 'primary-tab')
  assert.deepEqual(emitted[0].bounds, { x: 0, y: 0, w: 400, h: 600 })
  assert.equal(emitted[1].tabId, 'secondary-tab')
  assert.deepEqual(emitted[1].bounds, { x: 400, y: 0, w: 400, h: 600 })
})

test('split mode with secondary pane unmounted: only primary intent fires (no spurious secondary)', async () => {
  const emitted: BrowserViewIntent[] = []
  const send = makeSendBoundsImmediate({
    activeTabId: 'primary-tab',
    splitTabId: 'secondary-tab',
    primary: { x: 0, y: 0, width: 800, height: 600 },
    secondary: null, // pane mounted but ref hasn't measured yet
    emit: (intent) => emitted.push(intent),
  })

  await send()

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].kind, 'set-bounds')
})

test('no split active: only primary intent fires even if a secondary measurement happens to exist', async () => {
  const emitted: BrowserViewIntent[] = []
  const send = makeSendBoundsImmediate({
    activeTabId: 'primary-tab',
    splitTabId: null,
    primary: { x: 0, y: 0, width: 800, height: 600 },
    secondary: { x: 0, y: 0, width: 0, height: 0 },
    emit: (intent) => emitted.push(intent),
  })

  await send()

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].kind, 'set-bounds')
})

test('split with same primary+secondary tab id is a no-op for the secondary intent (defensive against bad state)', async () => {
  const emitted: BrowserViewIntent[] = []
  const send = makeSendBoundsImmediate({
    activeTabId: 'tab-a',
    splitTabId: 'tab-a',
    primary: { x: 0, y: 0, width: 800, height: 600 },
    secondary: { x: 0, y: 0, width: 400, height: 600 },
    emit: (intent) => emitted.push(intent),
  })

  await send()

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].kind, 'set-bounds')
})

test('useBrowserViewBounds source code still emits both intents in the same code block (regression guard)', async () => {
  // Source-grep guard against silent regression of the dual-emission
  // path in `useBrowserViewBounds.sendBoundsImmediate`. If a future
  // refactor moves the secondary emission to a different code path, the
  // "within one frame" property may break — this guard catches that
  // structurally.
  const fs = await import('node:fs')
  const path = await import('node:path')
  // eslint-disable-next-line ready/no-source-grep-test -- Stage X4.3 paired structural gate: the behavior test above proves dual-emit via test double; this regex pins the production hook's single-callback shape so a future refactor that splits the secondary emission into a different code path cannot silently break the "within one frame" property.
  const hookSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/modules/browser/useBrowserViewBounds.ts'),
    'utf8',
  )
  // Within the same callback body, both intents must appear and the
  // secondary must follow the primary.
  assert.match(
    hookSrc,
    /const sendBoundsImmediate = useCallback\(async \(options[\s\S]*kind: 'set-bounds'[\s\S]*kind: 'secondary-set-bounds'[\s\S]*\}, \[activeTabId, measureBounds, measureSplitBounds, splitTabId\]\)/,
  )
})
