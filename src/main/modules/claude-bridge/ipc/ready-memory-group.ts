import type { IpcMain } from 'electron'

import {
  parseReadyMemoryAddRequest,
  parseReadyMemoryConversationPolicyRequest,
  parseReadyMemoryDeleteRequest,
  parseReadyMemoryGlobalPolicyRequest,
  parseReadyMemoryPinRequest,
  parseReadyMemoryReadRequest,
  parseReadyMemoryResetRequest,
  parseReadyMemoryUpdateRequest,
  parseReadyMemoryView,
  type ReadyMemoryAddRequest,
  type ReadyMemoryConversationPolicyRequest,
  type ReadyMemoryDeleteRequest,
  type ReadyMemoryGlobalPolicyRequest,
  type ReadyMemoryPinRequest,
  type ReadyMemoryReadRequest,
  type ReadyMemoryResetRequest,
  type ReadyMemoryUpdateRequest,
  type ReadyMemoryView,
} from '../../../../shared/ready-memory'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

type ReadyMemoryResponse =
  | { success: true; data: ReadyMemoryView }
  | { success: false; error: string }

export interface ReadyMemoryGroupDeps {
  read(request: ReadyMemoryReadRequest): ReadyMemoryView
  setGlobalPolicy(request: ReadyMemoryGlobalPolicyRequest): ReadyMemoryView
  setConversationPolicy(request: ReadyMemoryConversationPolicyRequest): ReadyMemoryView
  add(request: ReadyMemoryAddRequest): ReadyMemoryView
  update(request: ReadyMemoryUpdateRequest): ReadyMemoryView
  pin(request: ReadyMemoryPinRequest): ReadyMemoryView
  delete(request: ReadyMemoryDeleteRequest): ReadyMemoryView
  reset(request: ReadyMemoryResetRequest): ReadyMemoryView
}

const CHANNELS = [
  'agent:readReadyMemory',
  'agent:setReadyMemoryGlobalPolicy',
  'agent:setReadyMemoryConversationPolicy',
  'agent:addReadyMemory',
  'agent:updateReadyMemory',
  'agent:pinReadyMemory',
  'agent:deleteReadyMemory',
  'agent:resetReadyMemory',
] as const

function response(operation: () => ReadyMemoryView): ReadyMemoryResponse {
  try {
    return { success: true, data: parseReadyMemoryView(operation()) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'ready_memory_failed' }
  }
}

export const readyMemoryGroup: IpcChannelGroup<ReadyMemoryGroupDeps> = {
  namespace: 'agent:ready-memory',

  register(ipcMain: IpcMain, deps: ReadyMemoryGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* handler may not exist */ }
    }
    ipcMain.handle('agent:readReadyMemory', (_, raw: unknown) => response(
      () => deps.read(parseReadyMemoryReadRequest(raw)),
    ))
    ipcMain.handle('agent:setReadyMemoryGlobalPolicy', (_, raw: unknown) => response(
      () => deps.setGlobalPolicy(parseReadyMemoryGlobalPolicyRequest(raw)),
    ))
    ipcMain.handle('agent:setReadyMemoryConversationPolicy', (_, raw: unknown) => response(
      () => deps.setConversationPolicy(parseReadyMemoryConversationPolicyRequest(raw)),
    ))
    ipcMain.handle('agent:addReadyMemory', (_, raw: unknown) => response(
      () => deps.add(parseReadyMemoryAddRequest(raw)),
    ))
    ipcMain.handle('agent:updateReadyMemory', (_, raw: unknown) => response(
      () => deps.update(parseReadyMemoryUpdateRequest(raw)),
    ))
    ipcMain.handle('agent:pinReadyMemory', (_, raw: unknown) => response(
      () => deps.pin(parseReadyMemoryPinRequest(raw)),
    ))
    ipcMain.handle('agent:deleteReadyMemory', (_, raw: unknown) => response(
      () => deps.delete(parseReadyMemoryDeleteRequest(raw)),
    ))
    ipcMain.handle('agent:resetReadyMemory', (_, raw: unknown) => response(
      () => deps.reset(parseReadyMemoryResetRequest(raw)),
    ))
    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* already removed */ }
        }
      },
    }
  },
}

export const _readyMemoryGroupChannelsForTest: readonly string[] = CHANNELS
