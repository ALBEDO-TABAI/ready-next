import { useDocTabs } from '../../stores/useDocTabs'

/**
 * Saving an untitled document tab (标签栏新建、path 为 null 的草稿) into a
 * directory chosen by dragging the tab onto the file tree.
 *
 * Filename derivation and uniquification are pure and tested; the executor
 * claims the name with `createFile` (refuses existing paths) before writing
 * content, so a stat/write race can never silently overwrite a file.
 */

const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g
const MAX_FILENAME_ATTEMPTS = 99

export function sanitizeUntitledDocTitle(title: string): string {
  const cleaned = title
    .replace(INVALID_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim()
  return cleaned || '新文档'
}

export function buildUntitledDocFileName(title: string, ordinal: number): string {
  const base = sanitizeUntitledDocTitle(title)
  return ordinal <= 1 ? `${base}.md` : `${base} ${ordinal}.md`
}

export async function pickAvailableUntitledDocFileName(
  title: string,
  exists: (fileName: string) => Promise<boolean>,
): Promise<string | null> {
  for (let ordinal = 1; ordinal <= MAX_FILENAME_ATTEMPTS; ordinal += 1) {
    const candidate = buildUntitledDocFileName(title, ordinal)
    if (!(await exists(candidate))) return candidate
  }
  return null
}

export function joinDirAndFileName(dir: string, name: string): string {
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${separator}${name}`
}

export type SaveUntitledDocTabResult =
  | { success: true; path: string; fileName: string }
  | { success: false; reason: 'not-untitled' | 'unavailable' | 'exhausted' | 'write-failed'; error?: string }

/**
 * Persist an untitled doc tab into `targetDir`, then flip the tab to the
 * saved path (title follows the filename via `setTabPath`).
 */
export async function saveUntitledDocTabToDirectory(
  tabId: string,
  targetDir: string,
): Promise<SaveUntitledDocTabResult> {
  const documentApi = window.electronAPI?.document
  if (!targetDir || !documentApi?.stat || !documentApi.createFile || !documentApi.writeFile) {
    return { success: false, reason: 'unavailable', error: '当前环境不支持文件写入' }
  }

  const { tabs, setTabPath, markTabSaved } = useDocTabs.getState()
  const tab = tabs.find((item) => item.id === tabId)
  // Only untitled drafts confirm a save location by drag; saved tabs keep
  // their existing file (moving files stays a file-tree operation).
  if (!tab || tab.path) {
    return { success: false, reason: 'not-untitled' }
  }

  const fileName = await pickAvailableUntitledDocFileName(tab.title, async (candidate) => {
    const stat = await documentApi.stat(joinDirAndFileName(targetDir, candidate)).catch(() => null)
    return Boolean(stat?.success)
  })
  if (!fileName) {
    return { success: false, reason: 'exhausted', error: '目录里同名文件过多' }
  }

  const fullPath = joinDirAndFileName(targetDir, fileName)
  const created = await documentApi.createFile(fullPath).catch((error: unknown) => ({
    success: false as const,
    error: error instanceof Error ? error.message : String(error),
  }))
  if (!created?.success) {
    return { success: false, reason: 'write-failed', error: created?.error || '创建文件失败' }
  }

  if (tab.content.length > 0) {
    const written = await documentApi.writeFile(fullPath, tab.content).catch((error: unknown) => ({
      success: false as const,
      error: error instanceof Error ? error.message : String(error),
    }))
    if (!written?.success) {
      return { success: false, reason: 'write-failed', error: written?.error || '写入文件失败' }
    }
  }

  setTabPath(tabId, fullPath)
  markTabSaved(tabId)
  return { success: true, path: fullPath, fileName }
}
