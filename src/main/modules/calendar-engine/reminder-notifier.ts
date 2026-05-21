/**
 * Reminder notifier — main-process only.
 *
 * Translates a `ReminderFirePayload` (emitted by `reminder-scheduler.ts` or
 * `reminder-cold-start.ts`) into:
 *   1. A native OS notification (Electron `Notification`) — title = event
 *      title, body = relative-time blurb. Click → focus mainWindow + push
 *      `agent:toolAction app.switchMode mode=calendar` IPC (the same channel
 *      the agent uses; renderer already wires this to switch mode).
 *   2. An IPC push `calendar:reminderFired` to renderer so the calendar UI
 *      can surface an in-app capsule independently of the OS notification.
 *
 * Pure dependency on a `mainWindow` accessor (closure) so timing of window
 * creation doesn't matter. If `mainWindow` is null (early boot / shutting
 * down) we still push to the renderer via webContents (no-op if absent) and
 * fall back to console.warn for the missing OS notification.
 *
 * Notification permission on macOS is granted lazily on first show; we don't
 * preflight. If `Notification.isSupported()` is false (older Linux, headless
 * test), we skip the OS notification but still push to renderer.
 */

import type { BrowserWindow } from 'electron'
import type { ReminderFirePayload } from './reminder-scheduler'

export interface ReminderNotifier {
  fire(payload: ReminderFirePayload): void
}

/**
 * Surface for tests + the production host. The Electron `Notification`
 * constructor is wrapped behind an injectable `notificationCtor` so unit
 * tests can avoid touching electron internals.
 */
export interface ReminderNotifierDeps {
  /** Lazily resolves the main window — closure pattern, may return null. */
  getMainWindow(): BrowserWindow | null
  /**
   * Notification constructor (default: Electron's `Notification`). Tests
   * inject a stub. Return value must support `.show()` and `.on('click', cb)`.
   */
  notificationCtor?: NotificationCtor
  /** Optional clock for fingerprinting / metric — defaults to Date.now()/1000. */
  now?(): number
}

export interface NotificationLike {
  show(): void
  on(event: 'click', listener: () => void): void
}

export type NotificationCtor = new (options: {
  title: string
  body: string
  silent?: boolean
}) => NotificationLike

/**
 * Build the human-readable body for a fired reminder. Examples:
 *   - "15 分钟后开始" (offset = -15)
 *   - "现在开始" (offset = 0, or |delta| < 30s)
 *   - "已开始 5 分钟" (offset = +5)
 *
 * `nowSeconds` is the current wall clock (cold-start may differ from
 * `firedAt` — pass `firedAt` for hot fire, `Date.now()/1000` for cold).
 */
export function buildReminderBody(payload: ReminderFirePayload, nowSeconds: number): string {
  const deltaSeconds = nowSeconds - payload.eventStartTime  // positive = past start
  // Use the larger-magnitude of {offsetMinutes, current delta} as the
  // displayed time. For hot fires they line up; for cold-start recoveries
  // the actual delta differs (e.g. scheduled for -15m but recovered 3m
  // after start → delta dominates).
  const minutes = Math.round(deltaSeconds / 60)
  if (Math.abs(deltaSeconds) < 30) return '现在开始'
  if (minutes > 0) return `已开始 ${minutes} 分钟`
  return `${Math.abs(minutes)} 分钟后开始`
}

function defaultNotificationCtor(): NotificationCtor | null {
  // Lazy require so this module loads cleanly in non-Electron Node (tests).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron')
    if (!electron.Notification) return null
    if (typeof electron.Notification.isSupported === 'function'
      && !electron.Notification.isSupported()) {
      return null
    }
    return electron.Notification as unknown as NotificationCtor
  } catch {
    return null
  }
}

export function createReminderNotifier(deps: ReminderNotifierDeps): ReminderNotifier {
  const resolvedCtor: NotificationCtor | null = deps.notificationCtor ?? defaultNotificationCtor()
  const nowFn = deps.now ?? (() => Math.floor(Date.now() / 1000))

  function pushIPC(payload: ReminderFirePayload): void {
    const win = deps.getMainWindow()
    if (!win) {
      console.warn(`[reminder-notifier] mainWindow null, skipping IPC push for event ${payload.eventId}`)
      return
    }
    try {
      // .isDestroyed is exposed on BrowserWindow; webContents is too once
      // destroyed it'll throw. Guard explicitly.
      if (typeof (win as unknown as { isDestroyed?: () => boolean }).isDestroyed === 'function'
        && (win as unknown as { isDestroyed: () => boolean }).isDestroyed()) {
        return
      }
      win.webContents.send('calendar:reminderFired', payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[reminder-notifier] IPC push failed for event ${payload.eventId}:`, message)
    }
  }

  function showOSNotification(payload: ReminderFirePayload): void {
    if (!resolvedCtor) {
      console.warn(`[reminder-notifier] Notification API unavailable for event ${payload.eventId}`)
      return
    }
    try {
      const notif = new resolvedCtor({
        title: payload.eventTitle || '日程提醒',
        body: buildReminderBody(payload, nowFn()),
        silent: payload.method === 'notification',  // 'sound' = let OS play default
      })
      notif.on('click', () => {
        const win = deps.getMainWindow()
        if (!win) return
        try {
          if (typeof (win as unknown as { isDestroyed?: () => boolean }).isDestroyed === 'function'
            && (win as unknown as { isDestroyed: () => boolean }).isDestroyed()) return
          if (typeof (win as unknown as { isMinimized?: () => boolean }).isMinimized === 'function'
            && (win as unknown as { isMinimized: () => boolean }).isMinimized()) {
            (win as unknown as { restore: () => void }).restore()
          }
          win.focus()
          // Same channel the agent uses for mode switches; renderer already
          // wires `agent:toolAction` { tool: 'app.switchMode' }.
          // Stage V V3.2 — reminder click is a global (no session) emit, but
          // the push payload must carry sessionId per the V3.2 contract so
          // listeners can distinguish global events. null = not session-scoped.
          win.webContents.send('agent:toolAction', {
            tool: 'app.switchMode',
            args: { mode: 'calendar', eventId: payload.eventId },
            sessionId: null,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[reminder-notifier] click handler failed for event ${payload.eventId}:`, message)
        }
      })
      notif.show()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[reminder-notifier] failed to show Notification for event ${payload.eventId}:`, message)
    }
  }

  return {
    fire(payload: ReminderFirePayload): void {
      // Push to renderer first — the in-app capsule is the more reliable
      // surface (OS notification permission may be denied). Doing it first
      // means a failing OS notification never blocks the renderer signal.
      pushIPC(payload)
      showOSNotification(payload)
    },
  }
}
