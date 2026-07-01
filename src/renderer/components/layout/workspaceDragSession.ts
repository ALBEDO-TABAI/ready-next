import type { WorkspaceDragPayload } from './fileTreeDragPayload'

/**
 * Module-level record of the file(s) currently being dragged inside the file
 * manager. During a `dragover` event Chromium keeps the drag data store in
 * "protected mode", so `dataTransfer.getData(...)` returns "" — meaning
 * `parseWorkspaceDragPayloads(dataTransfer)` yields nothing until the final
 * `drop`. Reading it there is fine for the move itself, but the hover
 * indicator needs the payload on every `dragover` tick. We therefore stash the
 * dragged items here at `dragstart` (mirroring the external browser-tab drag
 * session) and read them back during `dragover`.
 *
 * A defensive TTL clears a leaked session: `onDragEnd` clears on a normal drag
 * end, but does not fire if the source row is unmounted mid-drag.
 */
const WORKSPACE_DRAG_TTL_MS = 60_000

interface ActiveWorkspaceDragRecord {
  payloads: WorkspaceDragPayload[]
  createdAt: number
}

let activeWorkspaceDragRecord: ActiveWorkspaceDragRecord | null = null

export function beginWorkspaceDragSession(payloads: readonly WorkspaceDragPayload[]): void {
  if (payloads.length === 0) {
    activeWorkspaceDragRecord = null
    return
  }
  activeWorkspaceDragRecord = {
    payloads: payloads.map((payload) => ({ ...payload })),
    createdAt: Date.now(),
  }
}

export function getActiveWorkspaceDragPayloads(): WorkspaceDragPayload[] {
  if (!activeWorkspaceDragRecord) return []
  if (Date.now() - activeWorkspaceDragRecord.createdAt > WORKSPACE_DRAG_TTL_MS) {
    activeWorkspaceDragRecord = null
    return []
  }
  return activeWorkspaceDragRecord.payloads.map((payload) => ({ ...payload }))
}

export function endWorkspaceDragSession(): void {
  activeWorkspaceDragRecord = null
}
