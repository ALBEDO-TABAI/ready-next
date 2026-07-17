export interface DocumentDirectoryChangeEvent {
  paths: string[]
  timestamp: number
}

interface DocumentDirectoryChangeAPI {
  onDirectoryChange(handler: (event: DocumentDirectoryChangeEvent) => void): () => void
}

type DocumentDirectoryChangeHandler = (event: DocumentDirectoryChangeEvent) => void

const handlers = new Set<DocumentDirectoryChangeHandler>()
let uninstallIPC: (() => void) | null = null

export function installDocumentDirectoryChangeBridge(api: DocumentDirectoryChangeAPI | undefined): void {
  if (!api || uninstallIPC) return
  uninstallIPC = api.onDirectoryChange((event) => {
    for (const handler of [...handlers]) {
      try {
        handler(event)
      } catch (error) {
        console.error('[document-directory-change] subscriber failed', error)
      }
    }
  })
}

export function subscribeDocumentDirectoryChanges(handler: DocumentDirectoryChangeHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export function resetDocumentDirectoryChangeBridgeForTests(): void {
  uninstallIPC?.()
  uninstallIPC = null
  handlers.clear()
}
