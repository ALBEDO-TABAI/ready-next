import { createHash, randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, resolve } from 'path'
import {
  READY_BOARD_FILE_SUFFIX,
  createEmptyReadyBoardState,
  extractReadyBoardStateFromHtml,
  isReadyBoardFile,
  normalizeReadyBoardState,
  renderReadyBoardHtmlFromTemplate,
  type ReadyBoardAsset,
  type ReadyBoardAssetKind,
  type ReadyBoardImageNode,
  type ReadyBoardState,
} from '../../../shared/ready-board'
import { isPathAllowed } from '../app-control/local-path-safety'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogg'])
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])
const IMAGE_MAX_BYTES = 30 * 1024 * 1024
const VIDEO_MAX_BYTES = 512 * 1024 * 1024
const MARKDOWN_MAX_BYTES = 5 * 1024 * 1024
const REMOTE_IMAGE_MAX_BYTES = 30 * 1024 * 1024

export interface ReadyBoardHandleRecord {
  boardId: string
  absPath: string
  dir: string
}

export interface ReadyBoardOpenData {
  boardId: string
  path: string
  state: ReadyBoardState
}

export type BoardServiceResponse<T = void> = {
  success: boolean
  data?: T
  error?: string
  errorCode?: string
}

export interface BoardServiceDeps {
  readTemplate(): Promise<string>
  now?: () => Date
  fetch?: typeof fetch
  onDirectoryChanged?: (paths: string[]) => void
}

function fail<T>(error: string, errorCode = 'BOARD_ERROR'): BoardServiceResponse<T> {
  return { success: false, error, errorCode }
}

function sanitizeFileName(value: string): string {
  let next = ''
  for (const char of value.normalize('NFC')) {
    const code = char.charCodeAt(0)
    next += code <= 31 || '<>:"/\\|?*'.includes(char) ? '-' : char
  }
  return (next.trim() || 'asset').slice(0, 96)
}

function isSameOrDescendant(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent)
  const normalizedChild = resolve(child)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`)
}

async function realSafePath(path: string, mustExist: boolean): Promise<string | null> {
  if (!isPathAllowed(path)) return null
  if (!mustExist) return resolve(path)
  try {
    const real = await realpath(path)
    if (!isPathAllowed(real)) return null
    return real
  } catch {
    return null
  }
}

function extensionForMime(mime: string): string {
  const normalized = mime.split(';')[0].trim().toLowerCase()
  if (normalized === 'image/jpeg') return '.jpg'
  if (normalized === 'image/png') return '.png'
  if (normalized === 'image/gif') return '.gif'
  if (normalized === 'image/webp') return '.webp'
  if (normalized === 'image/svg+xml') return '.svg'
  if (normalized === 'image/bmp') return '.bmp'
  return '.img'
}

function kindFromExtension(ext: string): ReadyBoardAssetKind | null {
  const normalized = ext.toLowerCase()
  if (IMAGE_EXTENSIONS.has(normalized)) return 'image'
  if (VIDEO_EXTENSIONS.has(normalized)) return 'video'
  if (MARKDOWN_EXTENSIONS.has(normalized)) return 'markdown'
  return null
}

function maxBytesForKind(kind: ReadyBoardAssetKind): number {
  if (kind === 'image') return IMAGE_MAX_BYTES
  if (kind === 'video') return VIDEO_MAX_BYTES
  return MARKDOWN_MAX_BYTES
}

function isImageSignature(bytes: Uint8Array, ext: string, textPrefix = ''): boolean {
  const normalized = ext.toLowerCase()
  if (normalized === '.png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (normalized === '.jpg' || normalized === '.jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (normalized === '.gif') return textPrefix.startsWith('GIF87a') || textPrefix.startsWith('GIF89a')
  if (normalized === '.webp') return textPrefix.startsWith('RIFF') && textPrefix.slice(8, 12) === 'WEBP'
  if (normalized === '.bmp') return textPrefix.startsWith('BM')
  if (normalized === '.ico') return bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00
  if (normalized === '.svg') return /<svg[\s>]/i.test(textPrefix) || /<\?xml[\s\S]{0,300}<svg[\s>]/i.test(textPrefix)
  return false
}

async function assertLocalAssetKind(srcPath: string, requestedKind?: ReadyBoardAssetKind): Promise<ReadyBoardAssetKind> {
  const ext = extname(srcPath).toLowerCase()
  const kind = kindFromExtension(ext)
  if (!kind) throw new Error('不支持的素材类型')
  if (requestedKind && requestedKind !== kind) throw new Error('素材类型不匹配')

  const stats = await stat(srcPath)
  if (!stats.isFile()) throw new Error('素材不是文件')
  const maxBytes = maxBytesForKind(kind)
  if (stats.size > maxBytes) throw new Error('素材文件过大')

  if (kind === 'image') {
    const sample = await readFile(srcPath)
    const prefix = sample.subarray(0, 256).toString('utf8')
    if (!isImageSignature(sample, ext, prefix)) throw new Error('文件内容不是可识别图片')
  }

  return kind
}

async function readMarkdownExcerpt(path: string): Promise<{ title: string; excerpt: string }> {
  const content = await readFile(path, 'utf8')
  const lines = content.split(/\r?\n/)
  const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line))?.replace(/^#{1,3}\s+/, '').trim()
  const body = lines
    .filter((line) => line.trim() && !/^#{1,6}\s+/.test(line))
    .join('\n')
    .trim()
  return {
    title: heading || basename(path),
    excerpt: body.slice(0, 360),
  }
}

export class ReadyBoardService {
  private readonly handles = new Map<string, ReadyBoardHandleRecord>()
  private activeBoardId: string | null = null

  constructor(private readonly deps: BoardServiceDeps) {}

  async create(parentDir: string): Promise<BoardServiceResponse<ReadyBoardOpenData>> {
    const realParent = await realSafePath(parentDir, true)
    if (!realParent) return fail('目录不可访问', 'PATH_NOT_ALLOWED')
    const stats = await stat(realParent).catch(() => null)
    if (!stats?.isDirectory()) return fail('目标不是目录', 'NOT_DIRECTORY')

    const path = await this.nextBoardPath(realParent)
    const title = basename(path, READY_BOARD_FILE_SUFFIX)
    const state = { ...createEmptyReadyBoardState(title), updatedAt: this.nowIso() }
    const template = await this.deps.readTemplate()
    await this.atomicWrite(path, renderReadyBoardHtmlFromTemplate(template, state))
    this.deps.onDirectoryChanged?.([realParent])
    return this.register(path, state)
  }

  async open(absPath: string): Promise<BoardServiceResponse<ReadyBoardOpenData>> {
    if (!isReadyBoardFile(absPath)) return fail('不是 Ready 画板文件', 'NOT_BOARD_FILE')
    const real = await realSafePath(absPath, true)
    if (!real) return fail('文件不可访问', 'PATH_NOT_ALLOWED')
    if (!isReadyBoardFile(real)) return fail('不是 Ready 画板文件', 'NOT_BOARD_FILE')
    const html = await readFile(real, 'utf8')
    return this.register(real, extractReadyBoardStateFromHtml(html))
  }

  setActive(boardId: string | null): BoardServiceResponse {
    if (boardId === null) {
      this.activeBoardId = null
      return { success: true }
    }
    if (!this.handles.has(boardId)) return fail('画板句柄不存在', 'BOARD_HANDLE_NOT_FOUND')
    this.activeBoardId = boardId
    return { success: true }
  }

  async save(boardId: string, stateInput: unknown): Promise<BoardServiceResponse<ReadyBoardOpenData>> {
    const handle = this.handles.get(boardId)
    if (!handle) return fail('画板句柄不存在', 'BOARD_HANDLE_NOT_FOUND')
    const state = normalizeReadyBoardState({
      ...(stateInput && typeof stateInput === 'object' ? stateInput as Record<string, unknown> : {}),
      updatedAt: this.nowIso(),
    })
    const template = await this.deps.readTemplate()
    await this.atomicWrite(handle.absPath, renderReadyBoardHtmlFromTemplate(template, state))
    this.deps.onDirectoryChanged?.([handle.dir])
    return { success: true, data: { boardId, path: handle.absPath, state } }
  }

  async importAsset(
    boardId: string,
    srcPath: string,
    requestedKind?: ReadyBoardAssetKind,
  ): Promise<BoardServiceResponse<ReadyBoardAsset>> {
    try {
      const handle = this.handles.get(boardId)
      if (!handle) return fail('画板句柄不存在', 'BOARD_HANDLE_NOT_FOUND')
      const realSource = await realSafePath(srcPath, true)
      if (!realSource) return fail('素材不可访问', 'PATH_NOT_ALLOWED')
      if (isSameOrDescendant(join(handle.dir, 'assets'), realSource)) {
        return fail('不能从当前画板 assets 目录重新导入', 'ASSET_SOURCE_INSIDE_BOARD')
      }
      const kind = await assertLocalAssetKind(realSource, requestedKind)
      const asset = await this.copyAsset(handle, realSource, kind)
      return { success: true, data: asset }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 'ASSET_IMPORT_FAILED')
    }
  }

  async importRemoteImage(boardId: string, url: string): Promise<BoardServiceResponse<ReadyBoardAsset>> {
    const handle = this.handles.get(boardId)
    if (!handle) return fail('画板句柄不存在', 'BOARD_HANDLE_NOT_FOUND')
    return this.importRemoteImageForHandle(handle, url)
  }

  async addRemoteImageToActiveBoard(url: string): Promise<BoardServiceResponse<{ boardId: string; path: string; asset: ReadyBoardAsset; state: ReadyBoardState }>> {
    const boardId = this.activeBoardId
    if (!boardId) return fail('没有正在编辑的 Reference 画板', 'NO_ACTIVE_BOARD')
    const handle = this.handles.get(boardId)
    if (!handle) return fail('画板句柄不存在', 'BOARD_HANDLE_NOT_FOUND')
    const assetResult = await this.importRemoteImageForHandle(handle, url)
    if (!assetResult.success || !assetResult.data) {
      return fail(assetResult.error || '网页图片导入失败', assetResult.errorCode || 'REMOTE_FETCH_FAILED')
    }
    const opened = await this.open(handle.absPath)
    if (!opened.success || !opened.data) return fail('无法读取活动画板', 'BOARD_READ_FAILED')
    const node: ReadyBoardImageNode = {
      id: `node-${Date.now().toString(36)}`,
      type: 'image',
      src: assetResult.data.src,
      title: assetResult.data.title || assetResult.data.name,
      x: 0,
      y: 0,
      width: 360,
      height: 240,
    }
    const state = {
      ...opened.data.state,
      nodes: [...opened.data.state.nodes, node],
      updatedAt: this.nowIso(),
    }
    const saved = await this.save(boardId, state)
    if (!saved.success || !saved.data) return fail('无法保存活动画板', 'BOARD_SAVE_FAILED')
    return { success: true, data: { boardId, path: handle.absPath, asset: assetResult.data, state: saved.data.state } }
  }

  async openInDocument(boardId: string, relativePath: string): Promise<BoardServiceResponse<{ path: string }>> {
    const handle = this.handles.get(boardId)
    if (!handle) return fail('画板句柄不存在', 'BOARD_HANDLE_NOT_FOUND')
    if (!relativePath.startsWith('assets/') || relativePath.split('/').includes('..')) {
      return fail('素材路径无效', 'ASSET_PATH_INVALID')
    }
    const target = resolve(handle.dir, relativePath)
    if (!isSameOrDescendant(handle.dir, target)) return fail('素材路径越界', 'PATH_NOT_ALLOWED')
    if (!existsSync(target)) return fail('素材不存在', 'FILE_NOT_FOUND')
    return { success: true, data: { path: target } }
  }

  private async importRemoteImageForHandle(handle: ReadyBoardHandleRecord, url: string): Promise<BoardServiceResponse<ReadyBoardAsset>> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return fail('图片地址无效', 'INVALID_URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail('只支持 HTTP 图片', 'INVALID_URL')

    const fetcher = this.deps.fetch || fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetcher(url, { signal: controller.signal })
      if (!response.ok) return fail(`图片下载失败：${response.status}`, 'REMOTE_FETCH_FAILED')
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.toLowerCase().startsWith('image/')) return fail('远程资源不是图片', 'REMOTE_NOT_IMAGE')
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > REMOTE_IMAGE_MAX_BYTES) return fail('远程图片过大', 'REMOTE_IMAGE_TOO_LARGE')
      const ext = extensionForMime(contentType)
      const name = sanitizeFileName(basename(parsed.pathname) || `remote${ext}`)
      const sourceName = extname(name) ? name : `${name}${ext}`
      const asset = await this.writeAssetBytes(handle, buffer, sourceName, 'image')
      return { success: true, data: asset }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 'REMOTE_FETCH_FAILED')
    } finally {
      clearTimeout(timer)
    }
  }

  private async copyAsset(handle: ReadyBoardHandleRecord, srcPath: string, kind: ReadyBoardAssetKind): Promise<ReadyBoardAsset> {
    const bytes = await readFile(srcPath)
    const assetDir = join(handle.dir, 'assets')
    await mkdir(assetDir, { recursive: true })
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
    const safeName = sanitizeFileName(basename(srcPath))
    const fileName = `${hash}-${safeName}`
    const dest = join(assetDir, fileName)
    if (!existsSync(dest)) await copyFile(srcPath, dest)
    const asset = await this.assetRecord(handle, dest, kind)
    if (kind === 'markdown') {
      const md = await readMarkdownExcerpt(dest)
      asset.title = md.title
      asset.excerpt = md.excerpt
    }
    return asset
  }

  private async writeAssetBytes(handle: ReadyBoardHandleRecord, bytes: Buffer, sourceName: string, kind: ReadyBoardAssetKind): Promise<ReadyBoardAsset> {
    const assetDir = join(handle.dir, 'assets')
    await mkdir(assetDir, { recursive: true })
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
    const fileName = `${hash}-${sanitizeFileName(sourceName)}`
    const dest = join(assetDir, fileName)
    if (!existsSync(dest)) await writeFile(dest, bytes)
    return this.assetRecord(handle, dest, kind)
  }

  private async assetRecord(handle: ReadyBoardHandleRecord, absPath: string, kind: ReadyBoardAssetKind): Promise<ReadyBoardAsset> {
    const stats = await stat(absPath)
    const name = basename(absPath)
    return {
      src: `assets/${name}`,
      kind,
      name,
      absPath,
      size: stats.size,
    }
  }

  private async register(path: string, state: ReadyBoardState): Promise<BoardServiceResponse<ReadyBoardOpenData>> {
    const absPath = resolve(path)
    const boardId = randomUUID()
    const record = { boardId, absPath, dir: dirname(absPath) }
    this.handles.set(boardId, record)
    this.activeBoardId = boardId
    return { success: true, data: { boardId, path: absPath, state: normalizeReadyBoardState(state) } }
  }

  private async nextBoardPath(parentDir: string): Promise<string> {
    const baseName = '画板'
    let candidate = join(parentDir, `${baseName}${READY_BOARD_FILE_SUFFIX}`)
    let index = 2
    while (existsSync(candidate)) {
      candidate = join(parentDir, `${baseName} ${index}${READY_BOARD_FILE_SUFFIX}`)
      index += 1
    }
    return candidate
  }

  private nowIso(): string {
    return (this.deps.now ? this.deps.now() : new Date()).toISOString()
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, content, 'utf8')
    await rename(temp, path)
  }
}
