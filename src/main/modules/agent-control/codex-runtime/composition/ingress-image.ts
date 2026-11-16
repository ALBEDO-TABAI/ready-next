import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

/** Longest side a model is given; larger adds bytes to every later request of the conversation, not detail it uses. */
export const INGRESS_IMAGE_MAX_EDGE = 2048
const SMALL_ENOUGH_BYTES = 1024 * 1024
const KEEP_PREPARED_MS = 30 * 24 * 60 * 60 * 1000

export type IngressImageCodec = {
  /** Width and height of a decodable image, or null when this build cannot decode the file. */
  size(path: string): { width: number; height: number } | null
  /** The image fitted inside `maxEdge`, as JPEG when it has no transparency and PNG otherwise. */
  encode(path: string, maxEdge: number): { bytes: Buffer; extension: '.jpg' | '.png' } | null
}

/** Electron's decoder, loaded on first use: this module is also imported where Electron is not running. */
async function electronCodec(): Promise<IngressImageCodec> {
  const { nativeImage } = await import('electron')
  return {
    size(path) {
      const image = nativeImage.createFromPath(path)
      return image.isEmpty() ? null : image.getSize()
    },
    encode(path, maxEdge) {
      const source = nativeImage.createFromPath(path)
      if (source.isEmpty()) return null
      const { width, height } = source.getSize()
      const fitted = Math.max(width, height) > maxEdge
        ? source.resize({ ...(width >= height ? { width: maxEdge } : { height: maxEdge }), quality: 'best' })
        : source
      const bitmap = fitted.toBitmap()
      let transparent = false
      for (let offset = 3; offset < bitmap.length; offset += 4) {
        if (bitmap[offset] !== 255) { transparent = true; break }
      }
      return transparent
        ? { bytes: fitted.toPNG(), extension: '.png' }
        : { bytes: fitted.toJPEG(85), extension: '.jpg' }
    },
  }
}

/**
 * An attached image goes to the model on this turn and again, inside the history, on every later one. A camera
 * photo or a full-size PNG is megabytes each time and soon exceeds what a request may carry, after which every
 * turn of the conversation fails. So a large image is handed over as a fitted copy; the person's file is not
 * touched. Small images, and formats this build cannot decode, are passed as they are.
 */
export function createIngressImagePreparer(
  directory: string,
  loadCodec: () => Promise<IngressImageCodec> = electronCodec,
): (path: string) => Promise<string> {
  return async (path) => {
    const extension = extname(path).toLowerCase()
    if (!['.png', '.jpg', '.jpeg'].includes(extension)) return path
    const stat = statSync(path)
    const codec = await loadCodec()
    const size = codec.size(path)
    if (!size) return path
    if (stat.size <= SMALL_ENOUGH_BYTES && Math.max(size.width, size.height) <= INGRESS_IMAGE_MAX_EDGE) return path
    const key = createHash('sha256').update(JSON.stringify([path, stat.size, stat.mtimeMs, INGRESS_IMAGE_MAX_EDGE])).digest('hex')
    for (const candidate of ['.jpg', '.png']) {
      const prepared = join(directory, `${key}${candidate}`)
      if (existsSync(prepared)) return prepared
    }
    const encoded = codec.encode(path, INGRESS_IMAGE_MAX_EDGE)
    if (!encoded || encoded.bytes.length >= stat.size) return path
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // Copies are made rarely and the folder is small: clearing old ones on each write needs no state of its own.
    const cutoff = Date.now() - KEEP_PREPARED_MS
    for (const name of readdirSync(directory)) {
      const file = join(directory, name)
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file)
    }
    const prepared = join(directory, `${key}${encoded.extension}`)
    writeFileSync(prepared, encoded.bytes, { mode: 0o600 })
    return prepared
  }
}
