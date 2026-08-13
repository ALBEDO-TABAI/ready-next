import type { AgentRuntimeReadinessSnapshot } from '../../../shared/ipc-contracts/agent-runtime-readiness'

export function installAgentRuntimeReadyHydration(input: {
  read(): Promise<AgentRuntimeReadinessSnapshot>
  subscribe(listener: (snapshot: AgentRuntimeReadinessSnapshot) => void): () => void
  hydrate(snapshot: AgentRuntimeReadinessSnapshot): Promise<void>
}): () => void {
  let disposed = false
  let latestGeneration = 0
  let hydration = Promise.resolve()

  const accept = (snapshot: AgentRuntimeReadinessSnapshot): void => {
    if (disposed || !snapshot.ready || snapshot.bootGeneration <= latestGeneration) return
    latestGeneration = snapshot.bootGeneration
    hydration = hydration
      .then(async () => {
        if (disposed || snapshot.bootGeneration < latestGeneration) return
        await input.hydrate(snapshot)
      })
      .catch(() => undefined)
  }

  const unsubscribe = input.subscribe(accept)
  void input.read().then(accept).catch(() => undefined)

  return () => {
    disposed = true
    unsubscribe()
  }
}
