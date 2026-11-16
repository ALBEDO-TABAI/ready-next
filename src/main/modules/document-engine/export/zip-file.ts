import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import type JSZip from 'jszip'

/**
 * The one place an export archive is written: DEFLATE level 6 (an entry may opt out with its own `compression`),
 * streamed to the chosen path so a large archive is never held whole in memory a second time.
 */
export async function writeZipFile(zip: JSZip, filePath: string): Promise<void> {
  await pipeline(
    zip.generateNodeStream({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }),
    createWriteStream(filePath),
  )
}
