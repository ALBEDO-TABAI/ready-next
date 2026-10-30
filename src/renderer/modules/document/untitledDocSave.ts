import { finalizeDraftTab } from './drafts/save'
import { useDocTabs } from '../../stores/useDocTabs'

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
  if (!targetDir || !documentApi?.stat || !window.electronAPI.documentDrafts) {
    return { success: false, reason: 'unavailable', error: '当前环境不支持草稿保存' }
  }
  const tab = useDocTabs.getState().tabs.find(item => item.id === tabId)
  if (!tab || tab.path || tab.kind === 'library') return { success: false, reason: 'not-untitled' }

  const fileName = await pickAvailableUntitledDocFileName(tab.title, async (candidate) => {
    const stat = await documentApi.stat(joinDirAndFileName(targetDir, candidate))
    return Boolean(stat?.success)
  })
  if (!fileName) {
    return { success: false, reason: 'exhausted', error: '目录里同名文件过多' }
  }

  try {
    const saved = await finalizeDraftTab(tabId, { parentPath: targetDir, title: fileName.slice(0, -3), operationId: crypto.randomUUID() })
    return { success: true, path: saved.path, fileName: saved.path.split(/[\\/]/).pop()! }
  } catch (error) {
    return { success: false, reason: 'write-failed', error: error instanceof Error ? error.message : String(error) }
  }
}
