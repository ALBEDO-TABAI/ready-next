const pending = new Set<Promise<unknown>>()

/** Keep writes owned by unmounted canvas editors in the application's exit barrier. */
export function trackCanvasWrite<T>(work: Promise<T>): Promise<T> {
  pending.add(work)
  void work.then(() => pending.delete(work), () => pending.delete(work))
  return work
}
export async function flushCanvasWrites(): Promise<void> {
  const errors: unknown[] = []
  while (pending.size) {
    for (const result of await Promise.allSettled([...pending])) if (result.status === 'rejected') errors.push(result.reason)
  }
  if (errors.length) throw new AggregateError(errors, '画板保存失败')
}
