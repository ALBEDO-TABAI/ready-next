/**
 * bookTabEligibility.ts — 标签是否可进入阅读模式。
 * 与 DocumentMode.tsx 中 DocumentEditor 的路由保持一致：
 * 只有落到 MarkdownEditor 的文档（markdown/text/docx/untitled 等）可读。
 */

import { isReadyBoardFile } from '../../../../shared/ready-board'
import { getFileExtension } from '../../../utils/path'

// MarkdownEditor 的磁盘读取入口当前只接受这些格式。阅读入口必须使用同一事实，
// 不能用排除列表把未知格式误判成文本，再给用户一个必然读不到内容的按钮。
const BOOK_READABLE_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'json',
  'ts',
  'tsx',
  'js',
  'css',
  'html',
  'docx',
])

export function isBookReadablePath(path: string | null | undefined): boolean {
  if (!path) return true
  if ((isReadyBoardFile(path) || /\.canvas$/i.test(path))) return false
  const ext = getFileExtension(path)
  if (!ext) return true
  return BOOK_READABLE_EXTENSIONS.has(ext)
}

/** 阅读会话只属于进入时的标签；目标标签一变就先卸载阅读视图。 */
export function isBookReadingSessionVisible(
  active: boolean,
  readingTabId: string | null,
  targetTabId: string | null,
  eligible: boolean,
  sceneVisible: boolean,
): boolean {
  return active && sceneVisible && readingTabId !== null && readingTabId === targetTabId && eligible
}

/** 离开 Document 场景或目标标签变化时，必须结束本次阅读会话。 */
export function shouldFinalizeBookReadingSession(
  active: boolean,
  readingTabId: string | null,
  targetTabId: string | null,
  sceneVisible: boolean,
): boolean {
  return active && (!sceneVisible || readingTabId === null || readingTabId !== targetTabId)
}
