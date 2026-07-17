type DocumentSaveHandler = () => Promise<void> | void

interface DocumentSaveOwner {
  handler: DocumentSaveHandler
  serializationKey: string
}

const saveHandlers = new Map<string, DocumentSaveOwner>()
const saveTails = new Map<string, Promise<void>>()

export function getDocumentSaveSerializationKey(tabId: string, path: string | null): string {
  if (!path) return `tab:${tabId}`
  const slashPath = path.replace(/\\/g, '/')
  const collapsedPath = slashPath.startsWith('//')
    ? `//${slashPath.slice(2).replace(/\/{2,}/g, '/')}`
    : slashPath.replace(/\/{2,}/g, '/')
  const normalizedPath = /^[a-z]:\//i.test(collapsedPath) || collapsedPath.startsWith('//')
    ? collapsedPath.toLowerCase()
    : collapsedPath
  return `path:${normalizedPath}`
}

export function registerDocumentSaveHandler(
  tabId: string,
  handler: DocumentSaveHandler,
  serializationKey = getDocumentSaveSerializationKey(tabId, null),
): () => void {
  const owner = { handler, serializationKey }
  saveHandlers.set(tabId, owner)
  return () => {
    if (saveHandlers.get(tabId) === owner) saveHandlers.delete(tabId)
  }
}

export async function runRegisteredDocumentSave(tabId: string): Promise<boolean> {
  const owner = saveHandlers.get(tabId)
  if (!owner) return false
  await runSerializedDocumentSave(owner.serializationKey, () => Promise.resolve().then(owner.handler))
  return true
}

export function runSerializedDocumentSave<T>(tabId: string, operation: () => Promise<T>): Promise<T> {
  const previous = saveTails.get(tabId) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const tail = result.then(() => undefined, () => undefined)
  saveTails.set(tabId, tail)
  void tail.then(() => {
    if (saveTails.get(tabId) === tail) saveTails.delete(tabId)
  })
  return result
}

export async function waitForRegisteredDocumentSave(tabId: string): Promise<void> {
  await saveTails.get(tabId)
}

export function resetDocumentSaveRegistryForTests(): void {
  saveHandlers.clear()
  saveTails.clear()
}
