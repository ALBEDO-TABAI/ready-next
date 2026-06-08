import { extname } from 'path'

import type { FileEmergenceFileKind } from '../../../shared/file-emergence'

const DOCUMENT_EXTS = new Set(['.md', '.txt', '.pdf', '.doc', '.docx', '.rtf', '.odt', '.html', '.htm'])
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.scss', '.less', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.yaml', '.yml', '.toml', '.xml', '.sql', '.sh', '.bash', '.zsh', '.vue', '.svelte', '.astro', '.ini', '.cfg', '.conf', '.properties', '.log'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.tiff', '.svg'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v'])
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.opus'])
const SPREADSHEET_EXTS = new Set(['.xlsx', '.xls', '.csv', '.tsv'])

export function fileKindFromPath(path: string, isDirectory = false): FileEmergenceFileKind {
  if (isDirectory) return 'folder'
  const ext = extname(path).toLowerCase()
  if (ext === '.tldr') return 'design'
  if (DOCUMENT_EXTS.has(ext)) return 'document'
  if (CODE_EXTS.has(ext)) return 'code'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (SPREADSHEET_EXTS.has(ext)) return 'spreadsheet'
  return 'other'
}
