export interface ParentAbortLink {
  readonly childSignal: AbortSignal
  readonly dispose: () => void
}

export function linkParentAbort(
  parent: AbortSignal | null,
  childController: AbortController,
): ParentAbortLink {
  if (!parent) {
    return { childSignal: childController.signal, dispose: () => {} }
  }
  if (parent.aborted) {
    childController.abort(parent.reason)
    return { childSignal: childController.signal, dispose: () => {} }
  }
  const onParentAbort = (): void => {
    childController.abort(parent.reason)
  }
  parent.addEventListener('abort', onParentAbort, { once: true })
  return {
    childSignal: childController.signal,
    dispose: () => parent.removeEventListener('abort', onParentAbort),
  }
}
