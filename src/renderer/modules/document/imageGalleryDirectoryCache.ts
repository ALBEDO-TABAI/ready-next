import { BoundedLruCache } from '../../../shared/bounded-lru'

const DIRECTORY_CACHE_CAPACITY = 32
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'])

export interface ImageGallerySibling {
  src: string
  width: number
  height: number
  alt: string
  path: string
}

interface DirectoryItem {
  name: string
  path: string
  isDirectory: boolean
}

type ListDirectory = (directory: string) => Promise<{
  success: boolean
  items?: DirectoryItem[]
}>

const cache = new BoundedLruCache<string, Promise<ImageGallerySibling[]>>(DIRECTORY_CACHE_CAPACITY)
const subscribers = new Map<string, Set<() => void>>()
let listRequestCount = 0

export interface ImageGalleryRequestGate {
  begin(): number
  isCurrent(generation: number): boolean
  invalidate(): void
}

export function createImageGalleryRequestGate(): ImageGalleryRequestGate {
  let generation = 0
  return {
    begin: () => ++generation,
    isCurrent: (candidate) => candidate === generation,
    invalidate: () => { generation += 1 },
  }
}

function normalizePath(path: string): string {
  const withSlashes = path.replace(/\\/g, '/')
  if (/^[A-Za-z]:\/?$/.test(withSlashes)) return `${withSlashes.slice(0, 2)}/`
  const normalized = withSlashes.replace(/\/+$/, '')
  return normalized || '/'
}

export function getImageGalleryDirectory(filePath: string): string {
  const normalized = normalizePath(filePath)
  const separator = normalized.lastIndexOf('/')
  if (/^[A-Za-z]:\/[^/]+$/.test(normalized)) return normalized.slice(0, 3)
  if (separator <= 0) return separator === 0 ? '/' : ''
  return normalized.slice(0, separator)
}

function toLocalFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return normalized.startsWith('/') ? `local-file://${encoded}` : `local-file:///${encoded}`
}

export async function loadImageGalleryDirectory(
  rawDirectory: string,
  listDirectory: ListDirectory,
): Promise<ImageGallerySibling[]> {
  const directory = normalizePath(rawDirectory)
  const cached = cache.get(directory)
  if (cached) return cached

  listRequestCount += 1
  const pending = listDirectory(rawDirectory).then((result) => {
    if (!result.success || !result.items) return []
    return result.items
      .filter((item) => {
        if (item.isDirectory) return false
        const extension = item.name.split('.').pop()?.toLowerCase() || ''
        return IMAGE_EXTENSIONS.has(extension)
      })
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))
      .map((item) => ({
        src: toLocalFileUrl(item.path),
        width: 1920,
        height: 1080,
        alt: item.name,
        path: item.path,
      }))
  })
  cache.set(directory, pending)
  try {
    return await pending
  } catch (error) {
    if (cache.get(directory) === pending) cache.delete(directory)
    throw error
  }
}

export function subscribeImageGalleryDirectory(directory: string, listener: () => void): () => void {
  const normalized = normalizePath(directory)
  const listeners = subscribers.get(normalized) ?? new Set<() => void>()
  listeners.add(listener)
  subscribers.set(normalized, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) subscribers.delete(normalized)
  }
}

export function invalidateImageGalleryDirectories(changedPaths: ReadonlyArray<string>): number {
  const changed = new Set(changedPaths.map(normalizePath))
  let invalidated = 0
  const directories = new Set([...cache.keys(), ...subscribers.keys()])
  for (const directory of directories) {
    const matches = changed.has(directory) || Array.from(changed).some((path) => getImageGalleryDirectory(path) === directory)
    if (!matches) continue
    cache.delete(directory)
    invalidated += 1
    for (const listener of subscribers.get(directory) ?? []) listener()
  }
  return invalidated
}

export function resetImageGalleryDirectoryCacheForTests(): void {
  cache.clear()
  subscribers.clear()
  listRequestCount = 0
}

export function getImageGalleryDirectoryCacheStatsForTests(): { size: number; listRequests: number } {
  return { size: cache.size, listRequests: listRequestCount }
}
