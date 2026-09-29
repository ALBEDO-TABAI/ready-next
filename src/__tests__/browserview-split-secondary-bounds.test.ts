import assert from 'node:assert/strict'
import test from 'node:test'


test('useBrowserViewBounds source code still emits both intents in the same code block (regression guard)', async () => {
  // Source-grep guard against silent regression of the dual-emission
  // path in `useBrowserViewBounds.sendBoundsImmediate`. If a future
  // refactor moves the secondary emission to a different code path, the
  // "within one frame" property may break — this guard catches that
  // structurally.
  const fs = await import('node:fs')
  const path = await import('node:path')
  // eslint-disable-next-line ready/no-source-grep-test -- The native BrowserView hook cannot run in plain Node; this structural check pins paired bounds emission in one callback. It does not prove runtime timing.
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
