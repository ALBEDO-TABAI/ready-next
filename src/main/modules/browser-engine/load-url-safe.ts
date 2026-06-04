/**
 * Tolerant `loadURL` wrapper.
 *
 * Electron's `webContents.loadURL` REJECTS with `ERR_ABORTED (-3)` whenever a
 * navigation is superseded — by a redirect, a download, or another navigation
 * started before the first finished. This is normal browsing behavior (sites
 * like 小红书 bounce through anti-bot redirects), not a failure. Left uncaught,
 * the rejected promise surfaces as an unhandledRejection that can tear down the
 * whole main process. This helper swallows ERR_ABORTED and reports every other
 * error as a structured result; genuine load failures still surface through the
 * webContents `did-fail-load` event.
 */

interface LoadUrlCapableContents {
  loadURL(url: string): Promise<void>
}

const ERR_ABORTED = -3

export async function loadUrlIgnoringAbort(
  webContents: LoadUrlCapableContents,
  url: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await webContents.loadURL(url)
    return { ok: true }
  } catch (error) {
    const errno = (error as { errno?: number })?.errno
    if (errno === ERR_ABORTED) return { ok: true }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
