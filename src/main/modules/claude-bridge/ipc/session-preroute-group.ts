// EP4-A5 — session preroute channel group.
//
// One read-only channel: the renderer asks, at first-message time of a
// brand-new session, where the session SHOULD go (state-first / precedent /
// fallback) under the `agent_auto_routing` mode. The handler is a one-line
// forward to the bound runtime method — pure table+classifier, no model
// call, no side effects (the renderer owns acting on the decision).
//
// Settings read/write for the mode live in the settings-engine IPC
// (`settings:get/setAgentSessionPrerouteMode`), same split as the
// auto-narration switch.
import type { IpcMain } from 'electron'
import type { PrerouteResult } from '../../agent-control/agents/session-preroute'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface SessionPrerouteGroupDeps {
  /** Bound `runtime.evaluateSessionPreroute` — sync, pure evaluation. */
  evaluateSessionPreroute(firstMessage: string): PrerouteResult
}

const CHANNELS = [
  'agent:sessionPreroute:evaluate',
] as const

export const sessionPrerouteGroup: IpcChannelGroup<SessionPrerouteGroupDeps> = {
  namespace: 'agent:sessionPreroute',

  register(ipcMain: IpcMain, deps: SessionPrerouteGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:sessionPreroute:evaluate', (_, payload: { firstMessage?: string }): IPCResponse<PrerouteResult> => {
      try {
        const firstMessage = typeof payload?.firstMessage === 'string' ? payload.firstMessage : ''
        return { success: true, data: deps.evaluateSessionPreroute(firstMessage) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already removed */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertion). */
export const _sessionPrerouteGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
