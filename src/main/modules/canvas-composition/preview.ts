import { closeSync, openSync, readSync, fstatSync } from 'node:fs'
import { basename } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { ReadyRefSchema, type ReadyRef } from '../../../shared/ready-ref'
import { readDocumentSource } from '../../../shared/document-operations'
import type { CanvasDocumentPreview } from '../../../shared/document-drafts'
import type { ObjectRegistry } from '../object-service/registry'
import { checkedPath, hashBytes } from '../document-drafts/files'

export function readCanvasDocumentPreview(registry: ObjectRegistry, root: string, input: ReadyRef): CanvasDocumentPreview {
  const ref = ReadyRefSchema.parse(input)
  if (!['page', 'file', 'canvas'].includes(ref.kind) || !('id' in ref)) throw new Error('此引用不支持文档预览')
  const object = registry.get(ref.id)
  if (!object?.current_path || object.status !== 'present' || object.identity_state === 'conflict') throw new Error('原文已移动、删除或身份冲突')
  const path = checkedPath(root, object.current_path)
  if (object.kind !== 'markdown') throw new Error('此文件请打开查看')
  if (registry.register(path).id !== ref.id) throw new Error('原文身份已经变化')
  const fd = openSync(path, 'r'), bytes = Buffer.alloc(16384)
  try {
    const info = fstatSync(fd), length = readSync(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd)
    if (info.mtimeMs !== after.mtimeMs || info.size !== after.size) throw new Error('原文正在变化，请重试')
    const raw = new StringDecoder('utf8').write(bytes.subarray(0, length)), parsed = readDocumentSource(raw)
    return { ref, title: typeof parsed.frontmatter.title === 'string' ? parsed.frontmatter.title : basename(path, '.md'),
      markdown: parsed.body, version: hashBytes(`${info.mtimeMs}:${info.size}:${raw}`), truncated: info.size > length }
  } finally { closeSync(fd) }
}
