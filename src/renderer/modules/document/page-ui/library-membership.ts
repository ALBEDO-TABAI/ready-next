import { useVault } from '../../../stores/useVault'

/**
 * Whether a file lives in the library (W3 M4). Pages, databases, comments, synced blocks and sub-pages exist only
 * there; a file in a mounted folder is just a file, so those entries do not appear for it (L3).
 */
export function isInLibrary(path: string | null | undefined, libraryRoot: string | null | undefined): boolean {
  const file = path?.replace(/\\/g, '/')
  const root = libraryRoot?.replace(/\\/g, '/').replace(/\/$/, '')
  return !!file && !!root && file.startsWith(`${root}/`)
}

export function useLibraryRoot(): string | null {
  return useVault(state => state.view.data?.status === 'ready' ? state.view.data.root : null)
}

export function useInLibrary(path: string | null | undefined): boolean {
  return isInLibrary(path, useLibraryRoot())
}
