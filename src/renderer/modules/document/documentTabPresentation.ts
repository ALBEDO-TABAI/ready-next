import { getFileExtension } from '../../utils/path'

export function getDocumentTabFileTypeColor(path: string | null): string {
  const extension = path ? getFileExtension(path) : ''
  if (['md', 'txt', 'docx'].includes(extension)) return 'var(--ready-document-tab-doc-dot, #E97A2B)'
  if (['xlsx', 'csv', 'xls'].includes(extension)) return '#34D399'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(extension)) return '#8B5CF6'
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'pdf'].includes(extension)) return '#EB5757'
  return '#5B8DEF'
}
