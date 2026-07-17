type DocumentSaveHandler = () => Promise<void> | void

const saveHandlers = new Map<string, DocumentSaveHandler>()

export function registerDocumentSaveHandler(tabId: string, handler: DocumentSaveHandler): () => void {
  saveHandlers.set(tabId, handler)
  return () => {
    if (saveHandlers.get(tabId) === handler) saveHandlers.delete(tabId)
  }
}

export async function runRegisteredDocumentSave(tabId: string): Promise<boolean> {
  const handler = saveHandlers.get(tabId)
  if (!handler) return false
  await handler()
  return true
}

export function resetDocumentSaveRegistryForTests(): void {
  saveHandlers.clear()
}
