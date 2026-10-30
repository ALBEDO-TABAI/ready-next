import JSZip from 'jszip'
import { posix } from 'node:path'

export interface BookMetadata {
  title: string
  author: string
  year?: number
  publisher?: string
  language?: string
  subjects: string[]
  cover?: { bytes: Uint8Array; extension: string }
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const unxml = (value: string): string => value
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => entity[0] === '#'
    ? String.fromCodePoint(/^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
    : entities[entity.toLowerCase()] ?? match)
  .replace(/\s+/g, ' ').trim()
const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"|\\s${name}\\s*=\\s*'([^']*)'`, 'i'))?.slice(1).find(value => value != null)
const dcAll = (opf: string, name: string): string[] => [...opf.matchAll(new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`, 'gi'))].map(match => unxml(match[1])).filter(Boolean)

export async function epubMetadata(bytes: Uint8Array): Promise<BookMetadata> {
  const zip = await JSZip.loadAsync(bytes)
  const container = await zip.file('META-INF/container.xml')?.async('string')
  if (!container) throw new Error('EPUB 缺少 container.xml')
  const opfPath = attr(container.match(/<rootfile\b[^>]*>/i)?.[0] ?? '', 'full-path')
  const opf = opfPath ? await zip.file(opfPath)?.async('string') : undefined
  if (!opf || !opfPath) throw new Error('EPUB 缺少书籍元数据')
  const dc = (name: string) => dcAll(opf, name)[0] ?? ''
  const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map(match => ({
    id: attr(match[0], 'id'), href: attr(match[0], 'href'), type: attr(match[0], 'media-type') ?? '', props: attr(match[0], 'properties') ?? '',
  }))
  const coverId = attr(opf.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i)?.[0] ?? '', 'content')
  const coverItem = items.find(item => /\bcover-image\b/.test(item.props))
    ?? items.find(item => item.id === coverId && /^image\//.test(item.type))
    ?? items.find(item => /^image\//.test(item.type) && /cover/i.test(`${item.id} ${item.href}`))
  let cover: BookMetadata['cover']
  if (coverItem?.href && /^image\//.test(coverItem.type)) {
    const path = posix.normalize(posix.join(posix.dirname(opfPath), decodeURIComponent(coverItem.href)))
    const data = await zip.file(path)?.async('uint8array')
    if (!data) throw new Error('EPUB 声明的封面文件缺失')
    const extension = /png/.test(coverItem.type) ? 'png' : /webp/.test(coverItem.type) ? 'webp' : /gif/.test(coverItem.type) ? 'gif' : /svg/.test(coverItem.type) ? 'svg' : 'jpg'
    cover = { bytes: data, extension }
  }
  return {
    title: dc('title'), author: dcAll(opf, 'creator').slice(0, 3).join(' / '),
    language: dc('language'), publisher: dc('publisher'),
    year: Number(dc('date').match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1]) || undefined,
    subjects: dcAll(opf, 'subject').flatMap(value => value.split(/\s+--\s+|[;；]/)).map(value => value.trim()).filter(Boolean).slice(0, 6),
    cover,
  }
}

export function nameMetadata(file: string): Pick<BookMetadata, 'title' | 'author'> {
  const name = file.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_+/g, ' ')
    .replace(/\s*[([（【]\s*(z-?lib(rary)?(\.\w+)?|1lib|libgen|anna'?s archive)\s*[)\]）】]\s*/gi, ' ').trim()
  const by = name.match(/^(.*?)\s*[([（【]([^()[\]（）【】]{1,40})[)\]）】]\s*$/)
    ?? name.match(/^(.+?)\s+[-–—]\s+(.+)$/)
  return by ? { title: by[1].trim(), author: by[2].trim() } : { title: name, author: '' }
}

export function decodeBookText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
  }
}
