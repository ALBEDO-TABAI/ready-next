/**
 * Centralized Puppeteer Browser lifecycle. Tracks every browser launched
 * via Ready so we can guarantee close on app shutdown / force-quit.
 *
 * Usage: instead of `await puppeteer.launch(opts)`, call:
 *   const browser = await launchManagedBrowser(() => puppeteer.launch(opts))
 * The browser is registered in a Set; on `closeAllBrowsers()` (called from
 * before-quit), every still-open browser is `await browser.close()`-ed
 * (with 5s per-browser timeout). On timeout we fall back to SIGKILL on the
 * underlying chromium process so the leak does not survive the next shutdown.
 *
 * Audit context (Wave C / Task C3): User had 14 leaked Chrome processes
 * (1 main + ~7 helpers each × 2 sessions, surviving 1+ day each). The actual
 * launch site for those leaks lives inside `node_modules/rsshub`'s embedded
 * `rebrowser-puppeteer` (called from the rsshub-worker child process), which
 * is reaped via `rsshubManager.cleanup()` + boot-reaper. This module is the
 * forward-compatible seam for any future *direct* puppeteer use in our own
 * code (e.g. tools/browser-tools.ts has no current direct launch but might
 * grow one). It is dependency-free; no `puppeteer-core` import required.
 */

/**
 * Structural subset of puppeteer-core's `Browser` we depend on. Keeping this
 * structural avoids a new runtime dependency while remaining a drop-in target
 * for the real `import type { Browser } from 'puppeteer-core'`.
 */
export interface ManagedBrowserHandle {
  close(): Promise<void>
  on(event: 'disconnected', listener: () => void): unknown
  process(): { kill(signal: NodeJS.Signals | number): boolean } | null | undefined
}

const liveBrowsers = new Set<ManagedBrowserHandle>()

/**
 * Register a browser instance with the central tracker. The caller passes a
 * launcher thunk (e.g. `() => puppeteer.launch(opts)`); we run it, register
 * the result, and wire `disconnected` → auto-deregister so closed-by-other-code
 * browsers do not pile up in the Set.
 */
export async function launchManagedBrowser<B extends ManagedBrowserHandle>(
  launcher: () => Promise<B>,
): Promise<B> {
  const browser = await launcher()
  registerBrowser(browser)
  return browser
}

/**
 * Manually register a browser handle (for callers that obtained it through a
 * non-thunk path, e.g. `puppeteer.connect`).
 */
export function registerBrowser(browser: ManagedBrowserHandle): void {
  liveBrowsers.add(browser)
  try {
    browser.on('disconnected', () => liveBrowsers.delete(browser))
  } catch {
    // If `on` throws (unlikely; structural mismatch), skip — close-all will
    // still try to close it.
  }
}

/**
 * Close every browser registered via `launchManagedBrowser`. Each close is
 * raced against `perBrowserTimeoutMs`; on timeout we SIGKILL the underlying
 * chromium process if we can find a pid. Errors are collected, never thrown.
 */
export async function closeAllBrowsers(
  perBrowserTimeoutMs = 5_000,
): Promise<{ closed: number; errors: string[] }> {
  const errors: string[] = []
  let closed = 0
  for (const browser of Array.from(liveBrowsers)) {
    try {
      await Promise.race([
        browser.close(),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error('browser.close timeout')),
            perBrowserTimeoutMs,
          ),
        ),
      ])
      closed += 1
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
      // Fallback: force-kill the underlying chromium process if the puppeteer
      // close path hung. This is the actual leak escape valve.
      try {
        browser.process()?.kill('SIGKILL')
      } catch {
        // process() may itself throw on already-disconnected browsers; ignore.
      }
    } finally {
      liveBrowsers.delete(browser)
    }
  }
  return { closed, errors }
}

export function getLiveBrowserCount(): number {
  return liveBrowsers.size
}

/**
 * Test seam: drop the registry entirely. Intended for unit tests that need a
 * clean slate between cases. Production code should never call this.
 */
export function __resetBrowserRegistryForTests(): void {
  liveBrowsers.clear()
}
