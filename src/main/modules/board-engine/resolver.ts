/** Resolve after recovery, then recheck the active library before handing out its services. */
export function createCanvasResolver<T extends { recover(): Promise<unknown> }>(dependencies: {
  ready: Promise<void>; root(): string | null; create(root: string): T
}): () => Promise<T> {
  let current: { root: string; service: T; ready: Promise<unknown> } | undefined
  return async () => {
    await dependencies.ready
    for (;;) {
      const root = dependencies.root()
      if (!root) throw new Error('请先配置可用的资料库')
      if (current?.root !== root) {
        const service = dependencies.create(root)
        current = { root, service, ready: service.recover() }
      }
      const entry = current
      await entry.ready
      if (dependencies.root() === entry.root) return entry.service
    }
  }
}
