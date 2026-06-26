export const BROWSER_LOCAL_MEDIA_UPLOAD_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'tiff',
  'mp4',
  'mov',
  'm4v',
  'webm',
])

export interface BrowserLocalMediaUploadFile {
  path: string
  ext?: string
}

function normalizeExt(input: string | undefined | null): string {
  return String(input || '').trim().toLowerCase().replace(/^\./, '')
}

export function getBrowserLocalMediaUploadExt(file: BrowserLocalMediaUploadFile): string {
  const explicit = normalizeExt(file.ext)
  if (explicit) return explicit
  const name = String(file.path || '').split(/[\\/]/).pop() || ''
  return normalizeExt(name.split('.').pop())
}

export function isBrowserLocalMediaUploadFile(file: BrowserLocalMediaUploadFile): boolean {
  return Boolean(file.path) && BROWSER_LOCAL_MEDIA_UPLOAD_EXTENSIONS.has(getBrowserLocalMediaUploadExt(file))
}

export function filterBrowserLocalMediaUploadPaths(files: readonly BrowserLocalMediaUploadFile[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const file of files) {
    if (!isBrowserLocalMediaUploadFile(file)) continue
    const path = String(file.path || '').trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}
