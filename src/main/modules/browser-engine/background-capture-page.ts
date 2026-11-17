import type { BrowserWindow } from 'electron'

/** A JSON response the page itself requested, read after the fact. Never altered or intercepted. */
export interface CapturedPageResponse {
  url: string
  status: number
  mimeType: string
  body: string
}

export interface BackgroundPageObserveOptions {
  /** A response is kept when its URL contains one of these substrings. */
  urlIncludes: string[]
  maxResponses?: number
  maxBodyChars?: number
}

/**
 * One hidden page in the person's browser session. The caller drives it the way a person would: go to a page,
 * look at what it shows and what it loaded, close it.
 */
export interface BackgroundPageHandle {
  /** Resolves when the page stops loading. A navigation the page itself replaced (a redirect) is followed. */
  navigate(url: string, options?: { timeoutMs?: number }): Promise<void>
  /** Runs a read-only script in the page. A script that throws comes back as `{ __readyCaptureError }`. */
  evaluate(script: string): Promise<unknown>
  responses(): CapturedPageResponse[]
  waitForResponses(
    predicate: (responses: CapturedPageResponse[]) => boolean,
    timeoutMs: number,
  ): Promise<boolean>
  currentUrl(): string
  close(): Promise<void>
}

export interface BackgroundCapturePageOptions {
  observe?: BackgroundPageObserveOptions
  isAllowedUrl(url: string): boolean
  now?: () => number
}

const DEFAULT_MAX_RESPONSES = 16
const DEFAULT_MAX_BODY_CHARS = 1_500_000
/** All kept bodies together; a page that returns huge payloads cannot grow the main process without bound. */
const MAX_TOTAL_BODY_CHARS = 8_000_000
const NAVIGATION_ABORTED = -3
const OBSERVED_RESOURCE_TYPES = new Set(['XHR', 'Fetch'])

function wrapCaptureScript(script: string): string {
  return `
    (async () => {
      try {
        const __readyCaptureSource = ${JSON.stringify(script)}
        const __readyCaptureValue = await eval(__readyCaptureSource)
        return { __readyCaptureOk: true, value: __readyCaptureValue }
      } catch (error) {
        return {
          __readyCaptureOk: false,
          error: String((error && (error.stack || error.message)) || error || 'Unknown capture error'),
        }
      }
    })()
  `
}

export function createMockBackgroundPage(): BackgroundPageHandle {
  let url = ''
  return {
    async navigate(target) { url = target },
    async evaluate() { return { title: 'Mock Background Page', finalUrl: url, items: [] } },
    responses: () => [],
    waitForResponses: async () => false,
    currentUrl: () => url,
    async close() { /* nothing to release */ },
  }
}

/**
 * Wraps an already created hidden window. The window is created by the controller so that its session,
 * user agent and throttling policy stay in one place.
 */
export function createBackgroundCapturePage(
  window: BrowserWindow,
  options: BackgroundCapturePageOptions,
): BackgroundPageHandle {
  const webContents = window.webContents
  const now = options.now ?? Date.now
  const observe = options.observe
  const maxResponses = observe?.maxResponses ?? DEFAULT_MAX_RESPONSES
  const maxBodyChars = observe?.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS
  const captured: CapturedPageResponse[] = []
  const tracked = new Map<string, { url: string; status: number; mimeType: string }>()
  const bodyReads = new Set<Promise<void>>()
  let observing = false
  let closed = false
  let capturedChars = 0

  const blockDisallowedNavigation = (event: Electron.Event, targetUrl: string) => {
    if (options.isAllowedUrl(targetUrl)) return
    event.preventDefault()
  }
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', blockDisallowedNavigation)
  webContents.on('will-frame-navigate', blockDisallowedNavigation as never)
  webContents.on('will-redirect', blockDisallowedNavigation as never)

  const onDebuggerMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
    if (!observing || !observe) return
    const requestId = typeof params?.requestId === 'string' ? params.requestId : ''
    if (!requestId) return
    if (method === 'Network.responseReceived') {
      if (!OBSERVED_RESOURCE_TYPES.has(String(params.type || ''))) return
      const response = (params.response || {}) as { url?: string; status?: number; mimeType?: string }
      const url = String(response.url || '')
      if (!observe.urlIncludes.some((part) => part && url.includes(part))) return
      tracked.set(requestId, {
        url,
        status: Number(response.status) || 0,
        mimeType: String(response.mimeType || ''),
      })
      return
    }
    if (method === 'Network.loadingFailed') {
      tracked.delete(requestId)
      return
    }
    if (method !== 'Network.loadingFinished') return
    const meta = tracked.get(requestId)
    if (!meta) return
    tracked.delete(requestId)
    if (captured.length + bodyReads.size >= maxResponses) return
    const read = webContents.debugger
      .sendCommand('Network.getResponseBody', { requestId })
      .then((result: { body?: string; base64Encoded?: boolean }) => {
        const raw = String(result?.body || '')
        const body = result?.base64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw
        if (!body || body.length > maxBodyChars || capturedChars + body.length > MAX_TOTAL_BODY_CHARS) return
        capturedChars += body.length
        captured.push({ ...meta, body })
      })
      .catch(() => {
        // silent-catch: a body the browser already dropped is simply not observed; the page content is still read
      })
      .finally(() => { bodyReads.delete(read) })
    bodyReads.add(read)
  }
  const onDebuggerDetach = () => { observing = false }

  const startObserving = (): void => {
    if (!observe || observing || closed) return
    try {
      webContents.debugger.attach('1.3')
      webContents.debugger.on('message', onDebuggerMessage as never)
      webContents.debugger.on('detach', onDebuggerDetach)
      observing = true
      // Never awaited: on a page that has not navigated yet Network.enable waits for the renderer, so gating the
      // first load on it would wait forever. It takes effect as the page starts, before its scripts ask for data.
      void webContents.debugger.sendCommand('Network.enable').catch((error: unknown) => {
        if (closed) return
        observing = false
        console.warn('[background-capture] response observation unavailable:', error instanceof Error ? error.message : String(error))
      })
    } catch (error) {
      // The page is still readable without its responses; the caller falls back to what the page shows.
      console.warn('[background-capture] response observation unavailable:', error instanceof Error ? error.message : String(error))
      observing = false
    }
  }

  const stopObserving = (): void => {
    try {
      webContents.debugger.removeListener('message', onDebuggerMessage as never)
      webContents.debugger.removeListener('detach', onDebuggerDetach)
      if (webContents.debugger.isAttached()) webContents.debugger.detach()
    } catch {
      // silent-catch: the window is being destroyed; a debugger that is already gone needs no detach
    }
    observing = false
  }

  return {
    async navigate(url, navigateOptions) {
      if (closed) throw new Error('Background page is closed')
      if (!options.isAllowedUrl(url)) throw new Error('Blocked URL protocol. Only http: and https: are allowed.')
      startObserving()
      const timeoutMs = Math.max(5_000, navigateOptions?.timeoutMs ?? 30_000)
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => finish(new Error(`Timed out loading ${url}`)), timeoutMs)
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          webContents.removeListener('did-stop-loading', handleStop)
          webContents.removeListener('did-fail-load', handleFail as never)
          if (error) reject(error)
          else resolve()
        }
        const handleStop = () => finish()
        const handleFail = (
          _event: Electron.Event,
          errorCode: number,
          errorDescription: string,
          _validatedURL: string,
          isMainFrame: boolean,
        ) => {
          if (!isMainFrame || errorCode === NAVIGATION_ABORTED) return
          finish(new Error(`${errorDescription} (${errorCode})`))
        }
        webContents.on('did-stop-loading', handleStop)
        webContents.on('did-fail-load', handleFail as never)
        void webContents.loadURL(url).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          // The page replaced this navigation with its own (for example a redirect to a sign-in page).
          if (/ERR_ABORTED|\(-3\)/.test(message)) return
          finish(error instanceof Error ? error : new Error(message))
        })
      })
    },

    async evaluate(script) {
      if (closed) throw new Error('Background page is closed')
      const result = await webContents.executeJavaScript(wrapCaptureScript(script), true) as
        | { __readyCaptureOk?: boolean; value?: unknown; error?: string }
        | null
      if (result && result.__readyCaptureOk === false) {
        return { __readyCaptureError: result.error || 'Unknown capture error' }
      }
      return result && result.__readyCaptureOk ? result.value : result
    },

    responses: () => captured.map((entry) => ({ ...entry })),

    async waitForResponses(predicate, timeoutMs) {
      const deadline = now() + Math.max(0, timeoutMs)
      for (;;) {
        if (predicate(captured.map((entry) => ({ ...entry })))) return true
        if (closed || !observing || now() >= deadline) return false
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    },

    currentUrl: () => {
      try { return webContents.getURL() } catch { return '' }
    },

    async close() {
      if (closed) return
      closed = true
      if (bodyReads.size > 0) {
        await Promise.race([
          Promise.allSettled([...bodyReads]),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ])
      }
      stopObserving()
      try {
        webContents.removeListener('will-navigate', blockDisallowedNavigation)
        webContents.removeListener('will-frame-navigate', blockDisallowedNavigation as never)
        webContents.removeListener('will-redirect', blockDisallowedNavigation as never)
        webContents.stop()
      } catch {
        // silent-catch: the page is going away; listeners on a destroyed page need no removal
      }
      try {
        window.destroy()
      } catch {
        // silent-catch: an already destroyed window is the wanted end state
      }
    },
  }
}
