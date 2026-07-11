/**
 * Markdown bundle planning for the 导出 button's "Markdown 压缩包" option.
 *
 * Pure planning layer: resolves every local media reference in the document
 * against the filesystem (via an injected `fileExists` so tests drive it
 * without touching disk), assigns collision-free `assets/<name>` zip paths,
 * and rewrites the markdown to point at them. Zip assembly stays in the IPC
 * group where jszip and fs live.
 */
import { basename, extname, isAbsolute, resolve } from 'path'
import { rewriteMarkdownMediaRefs } from '../../../../shared/markdown-asset-refs'

export interface MarkdownBundleAsset {
  /** Absolute path of the source file on disk. */
  sourcePath: string
  /** Path inside the zip's document folder, always `assets/<name>`. */
  zipPath: string
}

export interface MarkdownBundlePlan {
  /** Document text with every packed reference rewritten to `assets/<name>`. */
  markdown: string
  assets: MarkdownBundleAsset[]
  /** Raw destinations that looked local but did not resolve to a file. */
  missing: string[]
}

// eslint-disable-next-line no-control-regex -- intentionally strips control chars from filenames
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]+/g

function sanitizeAssetName(name: string): string {
  const cleaned = name.replace(UNSAFE_FILENAME_CHARS, '_').trim()
  return cleaned || 'asset'
}

export function sanitizeExportFolderName(name: string): string {
  const cleaned = name
    .replace(UNSAFE_FILENAME_CHARS, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || '导出文档'
}

export function planMarkdownBundle(options: {
  content: string
  /** Directory of the source document; null for untitled drafts. */
  documentDir: string | null
  fileExists: (absolutePath: string) => boolean
}): MarkdownBundlePlan {
  const { content, documentDir, fileExists } = options
  const assets: MarkdownBundleAsset[] = []
  const missing: string[] = []
  const zipPathBySource = new Map<string, string>()
  const usedNames = new Set<string>()

  const claimZipName = (sourcePath: string): string => {
    const existing = zipPathBySource.get(sourcePath)
    if (existing) return existing
    const ext = extname(sourcePath)
    const stem = sanitizeAssetName(basename(sourcePath, ext))
    let candidate = `${stem}${ext}`
    for (let suffix = 2; usedNames.has(candidate.toLowerCase()); suffix += 1) {
      candidate = `${stem}-${suffix}${ext}`
    }
    usedNames.add(candidate.toLowerCase())
    const zipPath = `assets/${candidate}`
    zipPathBySource.set(sourcePath, zipPath)
    assets.push({ sourcePath, zipPath })
    return zipPath
  }

  const markdown = rewriteMarkdownMediaRefs(content, (ref) => {
    if (!ref.localCandidate) return null
    // Windows-style separators in hand-written relative refs.
    const candidate = ref.localCandidate.replace(/\\/g, '/')
    let absolutePath: string
    if (isAbsolute(candidate)) {
      absolutePath = candidate
    } else if (documentDir) {
      absolutePath = resolve(documentDir, candidate)
    } else {
      missing.push(ref.rawDest)
      return null
    }
    if (!fileExists(absolutePath)) {
      missing.push(ref.rawDest)
      return null
    }
    return claimZipName(absolutePath)
  })

  return { markdown, assets, missing }
}
