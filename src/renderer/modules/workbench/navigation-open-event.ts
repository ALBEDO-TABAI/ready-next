import type { ReadyRef } from '../../../shared/ready-ref'
import type { WorkbenchMode } from '../../stores/useMode'
export type ObjectOpen = { mode: WorkbenchMode; title: string } & ({ ref: ReadyRef } | { path: string })
let listener: ((open: ObjectOpen) => void) | undefined
let replayDepth = 0
export function onUserObjectOpen(callback: (open: ObjectOpen) => void) { listener = callback }
export function userOpenedObject(open: ObjectOpen): void { if (!replayDepth) listener?.(open) }
export async function withoutOpenRecording<T>(work: () => T | Promise<T>): Promise<T> {
  replayDepth++
  try { return await work() } finally { replayDepth-- }
}
