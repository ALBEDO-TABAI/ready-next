import type { AgentRuntimeReadinessSnapshot } from '../shared/ipc-contracts/agent-runtime-readiness'

export function createAgentRuntimeInvokeGate(input: {
  read(): Promise<AgentRuntimeReadinessSnapshot>
  subscribe(listener: (snapshot: AgentRuntimeReadinessSnapshot) => void): () => void
}) {
  let readyGeneration = 0
  let releaseReady: (() => void) | null = null
  let ready = new Promise<void>((resolve) => {
    releaseReady = resolve
  })

  const accept = (snapshot: AgentRuntimeReadinessSnapshot): void => {
    if (!snapshot.ready || snapshot.bootGeneration <= readyGeneration) return
    readyGeneration = snapshot.bootGeneration
    releaseReady?.()
    releaseReady = null
  }

  const unsubscribe = input.subscribe(accept)
  void input
    .read()
    .then(accept)
    .catch(() => undefined)

  return {
    async invoke<T>(call: () => Promise<T>): Promise<T> {
      await ready
      return call()
    },
    dispose(): void {
      unsubscribe()
      ready = Promise.resolve()
      releaseReady?.()
      releaseReady = null
    }
  }
}
