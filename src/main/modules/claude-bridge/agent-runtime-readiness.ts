import type { IpcMain, WebContents } from 'electron'
import type { AgentRuntimeReadinessSnapshot } from '../../../shared/ipc-contracts/agent-runtime-readiness'

const READ_CHANNEL = 'agent:readRuntimeReady'

let bootGeneration = 0
let ready = false
const waiters = new Set<{
  resolve: () => void
  reject: (error: Error) => void
}>()

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
  for (const waiter of waiters) waiter.resolve()
  waiters.clear()
  if (!webContents.isDestroyed()) webContents.send('agent:runtimeReady', snapshot)
  return snapshot
}

export function markAgentRuntimeUnavailable(): void {
  ready = false
  for (const waiter of waiters) waiter.reject(new Error('agent_runtime_unavailable'))
  waiters.clear()
}

export function waitForAgentRuntimeReady(): Promise<void> {
  if (ready) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    waiters.add({ resolve, reject })
  })
}
