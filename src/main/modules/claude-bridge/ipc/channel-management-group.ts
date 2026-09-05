// Stage V V2.1k — ChannelManagementGroup channel group.
//
// Bundles the 8 channels that expose the agent-channel CRUD surface
// (create/update + connectivity probe + per-channel enable toggle + delete +
// out-of-band send probe) PLUS the 3-step WeChat OpenClaw login subflow that
// hangs off the channel-config UI:
//
//   agent:upsertChannel                 (create or replace one channel row)
//   agent:testChannel                   (sidecar reachability check)
//   agent:startWechatLogin              (kick off WeChat QR/login session)
//   agent:getWechatLoginStatus          (poll login session state)
//   agent:submitWechatLoginVerifyCode   (submit verify code during login)
//   agent:deleteChannel                 (remove one channel row)
//   agent:setChannelEnabled             (flip enabled flag for one channel)
//   agent:sendChannelProbe              (out-of-band "hello" send)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.1k is a pure
// move — semantics must be byte-for-byte identical so the V5 IPC contract
// gate stays green and the channel-settings UI plus WeChat login flow do not
// notice the refactor).
//
// All eight channels live in one group because they share:
//   • the same domain concept (agent channel lifecycle: configure → probe →
//     enable; the WeChat login subflow is a channel-scoped onboarding ramp)
//   • the same dispose lifecycle (renderer boots them together when opening
//     the channels settings page)
//   • a closely-coupled dep surface (every handler is a one-line forward to
//     a `runtime.*` method)
//
// Per-group deps are NOT a `Pick<EngineDeps>` — same rationale as the other
// V2.1 groups: the dep surface is bound runtime methods (resolved fresh per
// `setupAgentIPC` invocation), not composition-root singletons. `engine-deps.ts`
// is reserved for true singletons; mixed/bound surfaces stay on the per-group
// interface where they belong.
import type { IpcMain } from 'electron'
import type {
  AgentChannelConfig,
  ChannelAdapterType,
} from '../../agent-control/contracts/types'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Local mirror of the host's `IPCResponse` shape. Inlined to avoid a back
 * import from `ipc-handler.ts` (the file we are extracting AWAY from); the
 * shape is stable across the codebase — see `IPCResponse<T>` in the host.
 */
interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * Upsert/test channel payload. Mirrors the inline anonymous type from the
 * pre-extraction handler verbatim so the runtime forward stays a one-liner.
 * The runtime narrows `type` against `ChannelAdapterType`.
 */
export interface UpsertChannelPayload {
  id?: string
  type: ChannelAdapterType
  name: string
  enabled?: boolean
  config?: Record<string, unknown>
}

/**
 * Start-wechat-login payload. Mirrors the inline anonymous type from the
 * pre-extraction handler verbatim.
 */
export interface StartWechatLoginPayload {
  id?: string
  force?: boolean
}

/**
 * Per-group deps. Mixed surface — see file header for why this is not
 * `Pick<EngineDeps, …>`.
 *
 * Each field is a bound runtime method (bound by the host so the group never
 * imports `AgentControlRuntime` and stays decoupled from the runtime
 * concrete class).
 */
export interface ChannelManagementGroupDeps {
  startChannelPairing(id: string): { code: string; expiresAt: string }
  /**
   * Bound `runtime.upsertChannel` — async, creates or replaces one channel
   * row and returns the resulting `AgentChannelConfig`.
   */
  upsertChannel(payload: UpsertChannelPayload): Promise<AgentChannelConfig>
  /**
   * Bound `runtime.testChannel` — async, performs a sidecar reachability
   * check; returns `{ success, error? }` (NEVER throws for protocol-level
   * failures — those are surfaced via `success: false`).
   */
  testChannel(payload: UpsertChannelPayload): Promise<{ success: boolean; error?: string }>
  /**
   * Bound `runtime.startWechatLogin` — async, kicks off a WeChat OpenClaw
   * login session. Returns the sidecar response bag (login URL / session key /
   * any inline error fields).
   */
  startWechatLogin(payload: StartWechatLoginPayload): Promise<Record<string, unknown>>
  /**
   * Bound `runtime.getWechatLoginStatus` — async, polls login session state
   * keyed by `(channelId, sessionKey)`. Returns the sidecar status bag.
   */
  getWechatLoginStatus(channelId: string, sessionKey: string): Promise<Record<string, unknown>>
  /**
   * Bound `runtime.submitWechatLoginVerifyCode` — async, submits a verify
   * code during the WeChat login subflow. Returns the sidecar response bag.
   */
  submitWechatLoginVerifyCode(
    channelId: string,
    sessionKey: string,
    code: string,
  ): Promise<Record<string, unknown>>
  /**
   * Bound `runtime.deleteChannel` — async, removes one channel row. Returns
   * `true` if a row existed, `false` if not.
   */
  deleteChannel(id: string): Promise<boolean>
  /**
   * Bound `runtime.setChannelEnabled` — async, flips the enabled flag for
   * one channel. Returns the resulting `AgentChannelConfig`, or `null` if
   * the channel does not exist.
   */
  setChannelEnabled(id: string, enabled: boolean): Promise<AgentChannelConfig | null>
  /**
   * Bound `runtime.sendChannelProbe` — async, sends a "hello" probe through
   * the named channel. Returns `{ success, error? }`.
   */
  sendChannelProbe(id: string, text: string): Promise<{ success: boolean; error?: string }>
}

const CHANNELS = [
  'agent:upsertChannel',
  'agent:startChannelPairing',
  'agent:testChannel',
  'agent:startWechatLogin',
  'agent:getWechatLoginStatus',
  'agent:submitWechatLoginVerifyCode',
  'agent:deleteChannel',
  'agent:setChannelEnabled',
  'agent:sendChannelProbe',
] as const

export const channelManagementGroup: IpcChannelGroup<ChannelManagementGroupDeps> = {
  namespace: 'agent:channelManagement',

  register(ipcMain: IpcMain, deps: ChannelManagementGroupDeps): IpcDisposeHandle {
    // setupAgentIPC runs on every dev reload; strip any prior handler so
    // `ipcMain.handle` does not throw on the second registration. Mirrors the
    // pre-extraction defensive `removeHandler` calls in `ipc-handler.ts`.
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('agent:startChannelPairing', async (_, payload: { id: string }): Promise<IPCResponse> => {
      try { return { success: true, data: deps.startChannelPairing(String(payload?.id || '')) } }
      catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
    })

    ipcMain.handle('agent:upsertChannel', async (_, payload: UpsertChannelPayload): Promise<IPCResponse> => {
      try {
        const channel = await deps.upsertChannel(payload)
        return { success: true, data: channel }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:testChannel', async (_, payload: UpsertChannelPayload): Promise<IPCResponse> => {
      try {
        const result = await deps.testChannel(payload)
        return { success: result.success, error: result.error }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:startWechatLogin', async (_, payload: StartWechatLoginPayload): Promise<IPCResponse> => {
      try {
        const result = await deps.startWechatLogin(payload || {})
        if (result.success === false) {
          return { success: false, error: String(result.error || 'wechat login failed'), data: result }
        }
        return { success: true, data: result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:getWechatLoginStatus', async (_, payload: {
      channelId?: string
      sessionKey?: string
    }): Promise<IPCResponse> => {
      try {
        const channelId = String(payload?.channelId || '')
        const sessionKey = String(payload?.sessionKey || '')
        if (!channelId) return { success: false, error: 'channelId is required' }
        const result = await deps.getWechatLoginStatus(channelId, sessionKey)
        if (result.success === false) {
          return { success: false, error: String(result.error || 'wechat login status failed'), data: result }
        }
        return { success: true, data: result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:submitWechatLoginVerifyCode', async (_, payload: {
      channelId?: string
      sessionKey?: string
      code?: string
    }): Promise<IPCResponse> => {
      try {
        const channelId = String(payload?.channelId || '')
        const sessionKey = String(payload?.sessionKey || '')
        const code = String(payload?.code || '')
        if (!channelId || !sessionKey || !code) return { success: false, error: 'channelId, sessionKey and code are required' }
        const result = await deps.submitWechatLoginVerifyCode(channelId, sessionKey, code)
        if (result.success === false) {
          return { success: false, error: String(result.error || 'wechat verify failed'), data: result }
        }
        return { success: true, data: result }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('agent:deleteChannel', async (_, payload: { id: string }): Promise<IPCResponse> => {
      try {
        const ok = await deps.deleteChannel(payload.id)
        return { success: ok, error: ok ? undefined : `Channel not found: ${payload.id}` }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:setChannelEnabled', async (_, payload: {
      id: string
      enabled: boolean
    }): Promise<IPCResponse> => {
      try {
        const channel = await deps.setChannelEnabled(payload.id, payload.enabled)
        if (!channel) return { success: false, error: `Channel not found: ${payload.id}` }
        return { success: true, data: channel }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('agent:sendChannelProbe', async (_, payload: {
      id: string
      text: string
    }): Promise<IPCResponse> => {
      try {
        const result = await deps.sendChannelProbe(payload.id, payload.text)
        return { success: result.success, error: result.error }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
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
export const _channelManagementGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
