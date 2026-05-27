import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('captureStableFrame is gated by a 2-second capture token — one capture per browser-entry window', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')

  assert.match(browserMode, /const CAPTURE_TOKEN_WINDOW_MS = 2000/)
  assert.match(browserMode, /const captureTokenConsumedRef = useRef\(false\)/)
  assert.match(browserMode, /const captureTokenExpiryTimerRef = useRef<number \| null>\(null\)/)
  assert.match(browserMode, /const wasActiveRef = useRef<boolean>\(isActive\)/)

  // New token issued when isActive flips false → true.
  assert.match(
    browserMode,
    /if \(isActive && !wasActiveRef\.current\) \{\s*captureTokenConsumedRef\.current = false\s*clearCaptureTokenExpiryTimer\(\)\s*captureTokenExpiryTimerRef\.current = window\.setTimeout\([\s\S]*CAPTURE_TOKEN_WINDOW_MS/,
  )
  // Token is consumed on first idle qualifying tick (ensures exactly one capture).
  assert.match(
    browserMode,
    /if \(captureTokenConsumedRef\.current\) return\s*captureTokenConsumedRef\.current = true/,
  )
  // If a handoff page finishes loading after the 2s capture token expires,
  // the startup mask still releases instead of leaving the browser surface blank.
  assert.match(
    browserMode,
    /if \(!captureTokenConsumedRef\.current\) return[\s\S]*setIsBrowserSurfaceReady\(true\)/,
  )
  // Capture is immediate within the token window — no 180ms setTimeout wrapper.
  assert.doesNotMatch(
    browserMode,
    /window\.setTimeout\([\s\S]{0,100}captureStableFrame\(\)[\s\S]{0,50}\}, 180\)/,
  )
  // Old per-trigger refresh ref is gone.
  assert.doesNotMatch(browserMode, /stableFrameRefreshTimerRef/)
  assert.doesNotMatch(browserMode, /clearStableFrameRefreshTimer/)

  // syncVisibleHost no longer samples a stable frame itself — the probe lives in its own effect.
  assert.doesNotMatch(
    browserMode,
    /const syncVisibleHost = async \(\) => \{[\s\S]*await syncBrowserVisibility\('visible',[\s\S]*?captureStableFrame\(\)/,
  )
})
