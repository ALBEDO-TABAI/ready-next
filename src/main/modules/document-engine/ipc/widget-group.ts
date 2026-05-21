// Stage V V2.3g — document-engine WidgetGroup channel cluster (final
// document-engine group).
//
// Bundles the 1 push-direction channel that carries widget commit
// notifications from the renderer back into the main-process pipeline
// executor:
//
//   document:widgetCommitted  (fire-and-forget push from renderer — `ipcMain.on`)
//
// The renderer dispatches this from
// `ipcRenderer.send('document:widgetCommitted', payload)` in
// `src/preload/index.ts`; the main side records the commit into the
// process-local `documentCommitRegistry` so the pipeline executor's
// `waitForCommitAfter(…)` can ack the actual editor write (not just the
// tool-call IPC round-trip).
//
// Handler body is lifted VERBATIM from `ipc-handler.ts` (V2.3g is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and the pipeline executor's commit-wait flow does not
// regress).
//
// PUSH-DIRECTION DECISION (recorded for the V5 IPC contract gate):
//   `document:widgetCommitted` is the SEND direction (renderer → main);
//   the V5 gate (`scripts/check-ipc-contract.cjs`) pairs `ipcRenderer.send`
//   in preload (`SEND_USED`) with `ipcMain.on` in main (`SEND_RECEIVED`).
//   Moving the listener from `ipc-handler.ts` to this file keeps the
//   channel literal visible on the main side; the preload-side
//   `ipcRenderer.send('document:widgetCommitted', …)` continues to
//   satisfy the pair. There is NO main-side `sender.send` push to relocate
//   because the channel flows ONE WAY (renderer → main only).
//
// Pattern reference for ipcMain.on groups:
//   `src/main/modules/claude-bridge/ipc/tool-event-group.ts` (V2.1b —
//   handles both `.on` and `.handle`; this group only needs `.on` because
//   widgetCommitted is push-only with no ack channel).
import type { IpcMain } from 'electron'
import type { DocumentWidgetCommitEvent } from '../document-commit-registry'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps. The widget handler only needs ONE collaborator — the
 * commit-registry sink — because the rest of the handler body is pure
 * payload validation. We inject `recordCommit` as a function (not the
 * full registry instance) so:
 *   • tests can stub the sink without constructing a real registry;
 *   • a future move (e.g. swapping the in-memory registry for an emitter)
 *     does not force a dep-surface rewrite.
 *
 * Not a `Pick<EngineDeps, …>` because the commit registry is a
 * module-scope singleton (`export const documentCommitRegistry = …`),
 * not a composition-root surface; lifting it into `engine-deps.ts` would
 * pull every group's tests into a registry-construction concern.
 */
export interface WidgetGroupDeps {
  /**
   * Record a renderer-confirmed widget commit into the pipeline executor's
   * commit registry. Invoked once per valid `document:widgetCommitted`
   * payload (after the handler's `tabId` / `widgetId` sanity guards).
   */
  recordCommit(event: DocumentWidgetCommitEvent): void
}

const LISTENER_CHANNELS = [
  'document:widgetCommitted',
] as const

export const widgetGroup: IpcChannelGroup<WidgetGroupDeps> = {
  namespace: 'document:widget',

  register(ipcMain: IpcMain, deps: WidgetGroupDeps): IpcDisposeHandle {
    // setupDocumentIPC may be re-entered on dev reload; strip any prior
    // listeners so re-registration does not double-fire. Mirrors the
    // pre-extraction defensive `ipcMain.removeAllListeners` call in
    // `ipc-handler.ts` and the V2.1b `tool-event-group` pattern for
    // listener-only channels.
    for (const channel of LISTENER_CHANNELS) {
      try { ipcMain.removeAllListeners(channel) } catch { /* ignore — channel may not have listeners */ }
    }

    // `document:widgetCommitted` is fire-and-forget (renderer uses `send`,
    // not `invoke`); `ipcMain.on` is the matching listener signature. Body
    // is side-effect only — no Promise to return.
    ipcMain.on('document:widgetCommitted', (_event, payload: DocumentWidgetCommitEvent) => {
      if (!payload || typeof payload !== 'object') return
      const tabId = typeof payload.tabId === 'string' ? payload.tabId : ''
      const widgetId = typeof payload.widgetId === 'string' ? payload.widgetId : ''
      const committedAt = typeof payload.committedAt === 'number' ? payload.committedAt : Date.now()
      if (!tabId || !widgetId) return
      deps.recordCommit({
        tabId,
        widgetId,
        requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
        committedAt,
      })
    })

    return {
      dispose(): void {
        for (const channel of LISTENER_CHANNELS) {
          try { ipcMain.removeAllListeners(channel) } catch { /* ignore — already cleared */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertion). */
export const _widgetGroupListenerChannelsForTest: ReadonlyArray<string> = LISTENER_CHANNELS
