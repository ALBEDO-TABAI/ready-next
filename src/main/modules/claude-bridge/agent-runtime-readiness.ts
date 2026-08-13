import type { IpcMain, WebContents } from 'electron'
import type { AgentRuntimeReadinessSnapshot } from '../../../shared/ipc-contracts/agent-runtime-readiness'

const READ_CHANNEL = 'agent:readRuntimeReady'

let bootGeneration = 0
let ready = false

export function registerAgentRuntimeReadinessIPC(ipcMain: IpcMain): void {
  ipcMain.removeHandler(READ_CHANNEL)
  ipcMain.handle(READ_CHANNEL, () => ({ ready, bootGeneration }))
}

export function beginAgentRuntimeRegistration(): void {
  ready = false
}

export function publishAgentRuntimeReady(webContents: WebContents): AgentRuntimeReadinessSnapshot {
  bootGeneration += 1
  ready = true
  const snapshot = { ready, bootGeneration }
  if (!webContents.isDestroyed()) webContents.send('agent:runtimeReady', snapshot)
  return snapshot
}

export function markAgentRuntimeUnavailable(): void {
  ready = false
}
