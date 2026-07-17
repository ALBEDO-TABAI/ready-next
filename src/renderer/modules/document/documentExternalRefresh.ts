import { getFileExtension } from '../../utils/path'

interface RefreshableDocumentTab {
  path: string | null
  isDirty: boolean
}

interface ActivationRefreshableDocumentTab extends RefreshableDocumentTab {
  content: string
}

export interface ExternalRefreshDocumentTab extends ActivationRefreshableDocumentTab {
  id: string
}

export interface ExternalRefreshReadResult {
  success?: boolean
  content?: string
}

export interface ExternalRefreshInFlightRequest {
  generation: number
  promise: Promise<boolean>
}

const RELOADABLE_TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'json', 'ts', 'tsx', 'js', 'css', 'html'])

function normalizeForPathMatch(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function isReloadableTextDocumentPath(path: string | null): boolean {
  if (!path) return false
  return RELOADABLE_TEXT_EXTENSIONS.has(getFileExtension(path))
}

export function isPathWithinChangedDirectory(filePath: string, changedDirectory: string): boolean {
  const file = normalizeForPathMatch(filePath)
  const dir = normalizeForPathMatch(changedDirectory)
  if (!file || !dir) return false
  return file === dir || file.startsWith(`${dir}/`)
}

export function shouldRefreshDocumentTabForDirectoryChange(
  tab: RefreshableDocumentTab,
  changedDirectories: string[],
): boolean {
  if (!tab.path || tab.isDirty) return false
  if (!isReloadableTextDocumentPath(tab.path)) return false
  return changedDirectories.some((dir) => isPathWithinChangedDirectory(tab.path!, dir))
}

export function shouldRefreshDocumentTabOnActivation(
  tab: ActivationRefreshableDocumentTab,
): boolean {
  return !tab.isDirty && isReloadableTextDocumentPath(tab.path)
}

export async function refreshCleanDocumentTabsFromDisk(
  candidateTabs: readonly ExternalRefreshDocumentTab[],
  dependencies: {
    readFile(path: string): Promise<ExternalRefreshReadResult>
    getCurrentTab(id: string): ExternalRefreshDocumentTab | null
    hydrateTab(id: string, content: string): void
    inFlight: Map<string, ExternalRefreshInFlightRequest>
  },
): Promise<Set<string>> {
  const results = await Promise.all(candidateTabs.map(async (candidate) => {
    if (!candidate.path || candidate.isDirty || !isReloadableTextDocumentPath(candidate.path)) {
      return { id: candidate.id, resolved: true }
    }
    const key = `${candidate.id}\u0000${candidate.path}`
    let request = dependencies.inFlight.get(key)
    if (request) {
      request.generation += 1
    } else {
      request = {
        generation: 0,
        promise: Promise.resolve(false),
      }
      const activeRequest = request
      activeRequest.promise = (async () => {
        try {
          while (true) {
            const readGeneration = activeRequest.generation
            const result = await dependencies.readFile(candidate.path!).catch((error) => {
              console.warn('[document-external-refresh] read failed', candidate.path, error)
              return null
            })
            let resolved = false
            if (result?.success) {
              resolved = true
              const current = dependencies.getCurrentTab(candidate.id)
              if (current && current.path === candidate.path && !current.isDirty) {
                const nextContent = result.content || ''
                if (current.content !== nextContent) dependencies.hydrateTab(current.id, nextContent)
              }
            }
            if (activeRequest.generation !== readGeneration) continue
            if (dependencies.inFlight.get(key) === activeRequest) dependencies.inFlight.delete(key)
            return resolved
          }
        } catch (error) {
          console.warn('[document-external-refresh] refresh failed', candidate.path, error)
          if (dependencies.inFlight.get(key) === activeRequest) dependencies.inFlight.delete(key)
          return false
        }
      })()
      dependencies.inFlight.set(key, request)
    }
    return { id: candidate.id, resolved: await request.promise }
  }))
  return new Set(results.filter((result) => result.resolved).map((result) => result.id))
}
