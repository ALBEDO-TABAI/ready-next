export interface DocumentLoadSnapshot {
  id: string
  path: string | null
  content: string
  isDirty: boolean
}

export function shouldApplyAsyncDocumentLoad(
  initial: DocumentLoadSnapshot,
  current: DocumentLoadSnapshot | null | undefined,
): boolean {
  if (!current) return false
  if (current.id !== initial.id) return false
  if (current.path !== initial.path) return false
  if (current.isDirty) return false
  return true
}
