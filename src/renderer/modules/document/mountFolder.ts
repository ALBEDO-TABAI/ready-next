import { useWorkspace } from '../../stores/useWorkspace'

/**
 * Mount a folder beside the library (W3 M4): pick it, then list it in the navigator's 文件夹 section and
 * in 设置 › 资料库. Returns an error message to show, or null (picked, or the picker was cancelled).
 */
export async function mountFolder(): Promise<string | null> {
  const result = await window.electronAPI?.document?.openFolder?.({ validateAsWorkspace: true })
  if (!result) return '当前环境未提供文件夹选择能力。'
  if (!result.success || !result.path) return result.error && result.error !== 'cancelled' ? result.error : null
  useWorkspace.getState().addPinnedFolder(result.path)
  return null
}
