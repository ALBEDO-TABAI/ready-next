import { getFileExtension } from '../../utils/path'

interface RefreshableDocumentTab {
  path: string | null
  isDirty: boolean
}

interface ActivationRefreshableDocumentTab extends RefreshableDocumentTab {
  content: string
}

const RELOADABLE_TEXT_EXTENSIONS = new Set(['md', 'txt', 'json', 'ts', 'tsx', 'js', 'css', 'html'])

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
  if (tab.content.length === 0) return false
  return !tab.isDirty && isReloadableTextDocumentPath(tab.path)
}
