import { basename, relative } from 'node:path'
import { z } from 'zod'
import type { ObjectRegistry } from '../object-service/registry'
import { canonicalObjectPath, isInside } from '../object-service/registry'
import type { FastCardRepository } from '../repositories/fastcard-repository'
import { publishBytes, safeDirectory, type FastCardMediaCache } from './media-cache'

/** Copy only a Main-owned, verified image into a present library page's attachments. */
export function copyFastCardImage(input: unknown, root: string, registry: ObjectRegistry, repository: FastCardRepository, cache: FastCardMediaCache): string {
  const { itemId, pageId } = z.strictObject({ itemId: z.string().min(1), pageId: z.string().min(1) }).parse(input)
  const page = registry.get(pageId), item = repository.list().find(item => item.id === itemId)
  if (page?.status !== 'present' || !page.current_path || !/\.md$/i.test(page.current_path)) throw new Error('图片需要保存到资料库页面')
  const path = canonicalObjectPath(page.current_path)
  if (!isInside(canonicalObjectPath(root), path)) throw new Error('页面不在当前资料库')
  if (item?.kind !== 'image' || item.media?.status !== 'cached') throw new Error('图片未收全，未插入文档')
  const directory = safeDirectory(root, relative(root, path).replace(/\.md$/i, '.assets').split('\\').join('/'))
  publishBytes(`${directory}/${item.media.key}`, cache.read(item.media))
  return `${basename(path).replace(/\.md$/i, '.assets')}/${item.media.key}`
}
