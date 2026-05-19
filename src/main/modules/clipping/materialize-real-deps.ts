import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import type { MaterializeDeps } from './materialize-to-vault'

const IMAGE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export function buildRealMaterializeDeps(): MaterializeDeps {
  return {
    readMarkdown: (path) => readFile(path, 'utf8'),
    unlink: (path) => unlink(path),
    ensureDir: async (path) => {
      await mkdir(path, { recursive: true })
    },
    writeFile: async (path, content) => {
      await writeFile(path, content)
    },
    statIsDirectory: async (path) => {
      const st = await stat(path)
      return st.isDirectory()
    },
    fetchImage: async (url, options) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), options.timeoutMs)
      const linkAbort = () => controller.abort()
      if (options.signal) options.signal.addEventListener('abort', linkAbort, { once: true })
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'user-agent': IMAGE_USER_AGENT,
            accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          },
          redirect: 'follow',
          signal: controller.signal,
        })
        if (!response.ok) return null
        const contentLengthHeader = response.headers.get('content-length')
        if (contentLengthHeader) {
          const declared = Number.parseInt(contentLengthHeader, 10)
          if (Number.isFinite(declared) && declared > options.maxBytes) return null
        }
        const reader = response.body?.getReader()
        if (!reader) return null
        const chunks: Uint8Array[] = []
        let total = 0

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            total += value.byteLength
            if (total > options.maxBytes) {
              try { await reader.cancel() } catch { /* noop */ }
              return null
            }
            chunks.push(value)
          }
        }
        const merged = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          merged.set(chunk, offset)
          offset += chunk.byteLength
        }
        const contentType = response.headers.get('content-type') || ''
        return { bytes: merged, contentType }
      } catch {
        return null
      } finally {
        clearTimeout(timer)
        if (options.signal) options.signal.removeEventListener('abort', linkAbort)
      }
    },
    joinPath: (...segments: string[]) => join(...segments),
    basename: (p: string) => basename(p),
    isAbsolute: (p: string) => isAbsolute(p),
  }
}
