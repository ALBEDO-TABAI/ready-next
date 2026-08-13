import { taskEventBridge } from '../../browser-engine/task-event-bridge'
import { createTaskEventProofListener, createTaskProofSink, type ProofSinkStore } from '../quality/proof-collector'

export class TaskEventProofSubscription {
  private dispose: (() => void) | null = null

  start(store: ProofSinkStore): void {
    this.stop()
    this.dispose = taskEventBridge.registerProjectionSink(
      createTaskEventProofListener(createTaskProofSink(store)),
    )
  }

  stop(): void {
    this.dispose?.()
    this.dispose = null
  }
}
