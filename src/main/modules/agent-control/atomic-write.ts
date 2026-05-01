import * as fs from 'node:fs'
import { dirname } from 'node:path'

function tempPathFor(path: string): string {
  return `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function atomicWriteText(path: string, content: string): void {
  fs.mkdirSync(dirname(path), { recursive: true })
  const tmp = tempPathFor(path)
  let fd: number | null = null
  let renamed = false
  try {
    fd = fs.openSync(tmp, 'w')
    fs.writeFileSync(fd, content, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, path)
    renamed = true
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // best-effort cleanup
      }
    }
    if (!renamed) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}
