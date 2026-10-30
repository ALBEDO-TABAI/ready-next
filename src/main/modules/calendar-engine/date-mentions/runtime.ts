import { createDateMentionNotifier } from './notifier'
import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { getDatabase } from '../../database'
import { AppSettingsRepository } from '../../repositories/app-settings-repository'
import { VaultService } from '../../settings-engine/vault-service'
import { configureDocumentWriteService, getDocumentWriteDependencies } from '../../document-engine/document-write-service'
import { publishDocumentIndexChanged } from '../../search-engine/ipc/document-index-events'
import { ReadyRefSchema, type ReadyRef } from '../../../../shared/ready-ref'
import type { ReminderFirePayload } from '../../../../shared/calendar-types'
import type { ObjectRegistry } from '../../object-service/registry'
import { configureDateMentionIndex } from './index-events'
import { DateMentionService } from './service'
import { DateMentionController, withDateMentionIndex } from './controller'

export function setupDateMentions(options: { registry: ObjectRegistry; ready: Promise<void>; getWindow(): BrowserWindow | null; reschedule(): Promise<void> }) {
  const vault = new VaultService(new AppSettingsRepository(), { home: app.getPath('home'), userData: app.getPath('userData'), isPackaged: app.isPackaged })
  const root = () => { const state = vault.get(); return state.status === 'ready' ? state.root : null }
  const controller = new DateMentionController(options.registry, new DateMentionService(options.registry.db, getDatabase().calendar), root)
  let pendingOpen: ReadyRef | null = null, ready = false
  const changed = () => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('dateMentions:changed')
  }
  configureDateMentionIndex(event => {
    if (!ready) return // startup recovery is followed by a full reconciliation below
    void controller.indexed(event).then(async () => { changed(); await options.reschedule() })
      .catch(error => console.error('[date-mentions] synchronization failed', error))
  })
  const writer = getDocumentWriteDependencies()
  if (!writer) throw new Error('Date mention writer unavailable')
  configureDocumentWriteService(withDateMentionIndex(writer, root, event => {
    const window = options.getWindow()
    publishDocumentIndexChanged(window?.webContents ?? { isDestroyed: () => true, send() {} }, event)
  }))
  const initialized = options.ready.then(async () => { await controller.rebuild(); ready = true; changed(); await options.reschedule() })
  initialized.catch(error => console.error('[date-mentions] initialization failed', error))
  ipcMain.handle('dateMentions:list', async () => { await initialized; await controller.settled(); return controller.list() })
  ipcMain.handle('dateMentions:locate', async (_event, input: unknown) => { await initialized; await controller.settled(); return controller.locate(ReadyRefSchema.parse(input)) })
  ipcMain.handle('dateMentions:takeOpen', async () => {
    await initialized
    await controller.settled()
    const ref = pendingOpen; pendingOpen = null
    if (ref) controller.locate(ref)
    return ref
  })
  const notify = createDateMentionNotifier({ controller, changed,
    preferences: () => getDatabase().calendar.snapshot().prefs ?? {},
    notification: () => Notification.isSupported() ? Notification : null,
    open: ref => {
      const window = options.getWindow()
      if (!window || window.isDestroyed()) return
      pendingOpen = ref
      if (window.isMinimized()) window.restore()
      window.show(); window.focus()
      window.webContents.send('agent:toolAction', { tool: 'app.switchMode', args: { mode: 'calendar' }, sessionId: null })
      window.webContents.send('dateMentions:open')
    },
  })
  return {
    pending: (until: number, now: number) => ready ? controller.pending(until, now) : [],
    fire(payload: ReminderFirePayload): void {
      if (ready) void controller.deliver(payload, notify).catch(error => console.error('[date-mentions] delivery failed', error))
    },
  }
}
