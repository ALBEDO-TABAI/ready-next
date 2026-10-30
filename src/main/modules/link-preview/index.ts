import { JSDOM } from 'jsdom'
import type { FastCardMediaCache } from '../fastcard/media-cache'
import type { FastCardMedia } from '../../../shared/fastcard'
import { fetchPublic, publicURL } from './fetch-public'

export interface LinkPreview { url: string; title?: string; description?: string; site?: string; imageUrl?: string; fetchedAt: string }
export function parsePreview(html: string, url: string): LinkPreview {
  // No resources and no runScripts: publisher markup is never executed or loaded.
  const dom = new JSDOM(html), document = dom.window.document
  const text = (value?: string | null) => value?.replace(/\s+/g, ' ').trim().slice(0, 500) || undefined
  const meta = (key: string) => document.querySelector(`meta[property="${key}"],meta[name="${key}"]`)?.getAttribute('content')
  let imageUrl: string | undefined
  try { const raw = meta('og:image') || meta('twitter:image'); if (raw) imageUrl = publicURL(raw, url).href } catch { /* Unsafe publisher image is not exposed. */ }
  const preview = { url: publicURL(url).href, title: text(meta('og:title') || document.title),
    description: text(meta('og:description') || meta('description')), site: text(meta('og:site_name')), imageUrl, fetchedAt: new Date().toISOString() }
  dom.window.close()
  return preview
}
export async function getLinkPreview(url: string): Promise<LinkPreview> {
  const result = await fetchPublic(url)
  if (!/^text\/html(?:;|$)/i.test(result.type)) throw new Error('Expected HTML preview')
  return parsePreview(result.body.toString('utf8'), result.url)
}
/** The caller publishes cached bytes through the same verified .assets writer used by FastCard. */
export async function cachePreviewImage(preview: LinkPreview, cache: FastCardMediaCache): Promise<FastCardMedia | undefined> {
  return preview.imageUrl ? cache.download(preview.imageUrl) : undefined
}

/** Trusted Main caller supplies a verified document/board location; never expose this as a renderer path API. */
export async function persistLinkPreview(preview: LinkPreview, cache: FastCardMediaCache, target: { libraryRoot: string; relativePath: string }): Promise<import('../../../shared/ready-canvas').NodeReady['preview']> {
  const { CanvasPathSchema } = await import('../../../shared/ready-canvas')
  const { safeDirectory, publishBytes, verifiedRead } = await import('../fastcard/media-cache')
  const { join, posix } = await import('node:path')
  CanvasPathSchema.parse(target.relativePath)
  if (!/\.(canvas|md)$/i.test(target.relativePath)) throw new Error('Invalid preview target')
  const media = await cachePreviewImage(preview, cache)
  if (media?.status === 'missing') throw new Error(`预览图片缺失：${media.error}`)
  let image: string | undefined
  if (media?.status === 'cached') {
    image = `${target.relativePath.replace(/\.(canvas|md)$/i, '')}.assets/${media.key}`
    const directory = safeDirectory(target.libraryRoot, posix.dirname(image)), path = join(directory, posix.basename(image))
    publishBytes(path, cache.read(media)); verifiedRead(path, media.sha256)
  }
  return { ...(preview.title ? { title: preview.title } : {}), ...(preview.description ? { description: preview.description } : {}),
    ...(preview.site ? { site: preview.site } : {}), fetchedAt: preview.fetchedAt, ...(image ? { image } : {}) }
}
