import { constants } from 'fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'path'
import { randomUUID } from 'crypto'
import type { RuntimeExternalServiceConfig } from '../../../shared/external-services'
import {
  IMAGE_GENERATION_CACHE_DIR_NAME,
  IMAGE_GENERATION_MAX_OUTPUT_BYTES,
  IMAGE_GENERATION_MAX_REFERENCE_BYTES,
  IMAGE_GENERATION_MAX_REFERENCE_COUNT,
  IMAGE_GENERATION_MAX_REFERENCE_TOTAL_BYTES,
  type GeneratedImageArtifact,
  type ImageGenerationPersistResult,
} from '../../../shared/image-generation'
import { ExternalServiceStore } from '../settings-engine/external-service-store'
import {
  generateImageBytes,
  resolveImageGenerationClientConfig,
  type ImageGenerationClientDependencies,
  type ImageGenerationReferenceInput,
} from './image-generation-client'

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const CACHE_MAX_FILES = 200
const CACHE_SCAN_LIMIT = 1_000
const REFERENCE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

interface EnvelopeResourceLike {
  kind?: unknown
  source?: unknown
  name?: unknown
  path?: unknown
  order?: unknown
}

interface ImageReferenceResource {
  name: string
  path: string
  order: number
  labelOrder: number
}

export interface ImageGenerationServiceStore {
  getRuntimeService(id: string): RuntimeExternalServiceConfig | null
  getFirstEnabledImageGenerationService(): RuntimeExternalServiceConfig | null
}

export interface GenerateImageInput {
  prompt: string
  serviceId?: string
  size?: string
  aspectRatio?: string
  imageSize?: string
  referenceImageOrders?: number[]
  requestEnvelope?: unknown
  signal?: AbortSignal
}

export interface ImageGenerationServiceDependencies {
  store?: ImageGenerationServiceStore
  cacheRoot?: string
  client?: ImageGenerationClientDependencies
  now?: () => Date
  uuid?: () => string
}

function imageReferencesFromEnvelope(envelope: unknown): ImageReferenceResource[] {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return []
  const resources = (envelope as { resources?: unknown }).resources
  if (!Array.isArray(resources)) return []
  const ordered = resources
    .filter((item): item is EnvelopeResourceLike => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .filter((item) => item.kind === 'attachment')
    .filter((item) => item.source === 'user_attachment' || item.source === 'explicit_reference')
    .map((item, index) => ({
      name: typeof item.name === 'string' ? item.name.trim() : '',
      path: typeof item.path === 'string' ? item.path.trim() : '',
      order: typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : index,
    }))
    .filter((item) => item.name && isAbsolute(item.path) && Boolean(REFERENCE_MIME_BY_EXTENSION[extname(item.path).toLowerCase()]))
    .sort((left, right) => left.order - right.order)
  return ordered.map((item, index) => ({ ...item, labelOrder: index + 1 }))
}

export function resolveOrderedImageReferences(
  envelope: unknown,
  requestedOrders?: number[],
): ImageReferenceResource[] {
  const references = imageReferencesFromEnvelope(envelope)
  if (requestedOrders === undefined) return references
  if (!Array.isArray(requestedOrders)) throw new Error('参考图序号必须是数组')
  if (requestedOrders.length > IMAGE_GENERATION_MAX_REFERENCE_COUNT) {
    throw new Error(`最多可选择 ${IMAGE_GENERATION_MAX_REFERENCE_COUNT} 张参考图`)
  }
  let previous = 0
  const selected = new Set<number>()
  for (const value of requestedOrders) {
    if (!Number.isInteger(value) || value < 1 || value > references.length) {
      throw new Error(`参考图序号 ${String(value)} 不存在`)
    }
    if (value <= previous) throw new Error('参考图序号必须按从小到大排列且不能重复')
    previous = value
    selected.add(value)
  }
  return references.filter((item) => selected.has(item.labelOrder))
}

function cleanFileStem(value: string): string {
  // eslint-disable-next-line no-control-regex -- normalize an untrusted generated filename before filesystem use
  const stem = value.replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-').trim()
  return stem.slice(0, 80) || 'generated-image'
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export class ImageGenerationService {
  private readonly store: ImageGenerationServiceStore
  private readonly cacheRoot: string
  private readonly clientDependencies: ImageGenerationClientDependencies
  private readonly now: () => Date
  private readonly uuid: () => string
  private cacheReady: Promise<void> | null = null
  private generatedSinceCleanup = 0

  constructor(dependencies: ImageGenerationServiceDependencies = {}) {
    this.store = dependencies.store || new ExternalServiceStore()
    this.cacheRoot = resolve(dependencies.cacheRoot || join(tmpdir(), IMAGE_GENERATION_CACHE_DIR_NAME))
    this.clientDependencies = dependencies.client || {}
    this.now = dependencies.now || (() => new Date())
    this.uuid = dependencies.uuid || randomUUID
  }

  getCacheRoot(): string {
    return this.cacheRoot
  }

  private async ensureCacheReady(): Promise<void> {
    if (!this.cacheReady) {
      this.cacheReady = this.prepareCache().catch((error) => {
        this.cacheReady = null
        throw error
      })
    }
    await this.cacheReady
  }

  private async prepareCache(): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true })
    const entries = (await readdir(this.cacheRoot, { withFileTypes: true })).slice(0, CACHE_SCAN_LIMIT)
    const files = (await Promise.all(entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(this.cacheRoot, entry.name)
        try {
          const info = await stat(path)
          return { path, name: entry.name, mtimeMs: info.mtimeMs }
        } catch {
          return null
        }
      })))
      .filter((item): item is { path: string; name: string; mtimeMs: number } => Boolean(item))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
    const cutoff = this.now().getTime() - CACHE_MAX_AGE_MS
    const removals = files.filter((file, index) => (
      file.name.endsWith('.tmp') || file.mtimeMs < cutoff || index >= CACHE_MAX_FILES
    ))
    await Promise.all(removals.map((file) => unlink(file.path).catch(() => undefined)))
  }

  private resolveService(serviceId?: string): RuntimeExternalServiceConfig {
    const service = serviceId
      ? this.store.getRuntimeService(serviceId)
      : this.store.getFirstEnabledImageGenerationService()
    if (!service) {
      throw new Error(serviceId ? '找不到所选 AI 生图服务' : '请先在设置中启用一个 AI 生图服务')
    }
    return service
  }

  private async readReferences(
    resources: ImageReferenceResource[],
  ): Promise<{ clientInputs: ImageGenerationReferenceInput[]; labels: Array<{ order: number; name: string }> }> {
    if (resources.length > IMAGE_GENERATION_MAX_REFERENCE_COUNT) {
      throw new Error(`最多支持 ${IMAGE_GENERATION_MAX_REFERENCE_COUNT} 张参考图`)
    }
    let totalBytes = 0
    const clientInputs: ImageGenerationReferenceInput[] = []
    const labels: Array<{ order: number; name: string }> = []
    for (const resource of resources) {
      const info = await stat(resource.path)
      if (!info.isFile()) throw new Error(`参考图 ${resource.labelOrder} 不是文件`)
      if (info.size > IMAGE_GENERATION_MAX_REFERENCE_BYTES) {
        throw new Error(`参考图 ${resource.labelOrder} 超过 20 MB 上限`)
      }
      totalBytes += info.size
      if (totalBytes > IMAGE_GENERATION_MAX_REFERENCE_TOTAL_BYTES) {
        throw new Error('参考图总大小超过 64 MB 上限')
      }
      const mimeType = REFERENCE_MIME_BY_EXTENSION[extname(resource.path).toLowerCase()]
      if (!mimeType) throw new Error(`参考图 ${resource.labelOrder} 格式不受支持`)
      clientInputs.push({
        name: resource.name,
        mimeType,
        bytes: new Uint8Array(await readFile(resource.path)),
      })
      labels.push({ order: resource.labelOrder, name: resource.name })
    }
    return { clientInputs, labels }
  }

  async generate(input: GenerateImageInput): Promise<GeneratedImageArtifact> {
    const prompt = String(input.prompt || '').trim()
    if (!prompt) throw new Error('请提供要生成的图片描述')
    await this.ensureCacheReady()
    const service = this.resolveService(input.serviceId)
    const config = resolveImageGenerationClientConfig(service)
    const references = resolveOrderedImageReferences(input.requestEnvelope, input.referenceImageOrders)
    const { clientInputs, labels } = await this.readReferences(references)
    const generated = await generateImageBytes({
      config,
      prompt,
      references: clientInputs,
      size: input.size,
      aspectRatio: input.aspectRatio,
      imageSize: input.imageSize,
      signal: input.signal,
    }, this.clientDependencies)
    const id = this.uuid()
    const createdAt = this.now().toISOString()
    const name = `ready-image-${createdAt.replace(/[:.]/g, '-')}-${id}.${generated.extension}`
    const path = join(this.cacheRoot, name)
    const tempPath = `${path}.tmp`
    await writeFile(tempPath, generated.bytes, { flag: 'wx' })
    try {
      await rename(tempPath, path)
    } catch (error) {
      await unlink(tempPath).catch(() => undefined)
      throw error
    }
    this.generatedSinceCleanup += 1
    if (this.generatedSinceCleanup >= 25) {
      this.generatedSinceCleanup = 0
      await this.prepareCache().catch(() => undefined)
    }
    return {
      id: `generated-image:${id}`,
      module: 'system',
      kind: 'generated_image',
      label: name,
      path,
      mimeType: generated.mimeType,
      createdAt,
      meta: {
        serviceId: service.id,
        model: config.model,
        protocol: config.protocol,
        prompt: prompt.slice(0, 500),
        referenceImages: labels,
        temporary: true,
      },
    }
  }

  async resolveCachedSource(sourcePath: string): Promise<string> {
    await this.ensureCacheReady()
    if (!isAbsolute(sourcePath)) throw new Error('生成图片路径无效')
    const [rootRealPath, sourceRealPath] = await Promise.all([
      realpath(this.cacheRoot),
      realpath(resolve(sourcePath)),
    ])
    if (!isInside(rootRealPath, sourceRealPath)) throw new Error('只能操作 Ready 临时生图')
    const info = await stat(sourceRealPath)
    if (!info.isFile()) throw new Error('生成图片不存在')
    if (info.size > IMAGE_GENERATION_MAX_OUTPUT_BYTES) throw new Error('生成图片超过 32 MB 上限')
    return sourceRealPath
  }

  async readCachedImage(sourcePath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(await this.resolveCachedSource(sourcePath)))
  }

  private async copyUnique(sourcePath: string, directoryPath: string): Promise<ImageGenerationPersistResult> {
    const source = await this.resolveCachedSource(sourcePath)
    const targetDirectory = resolve(directoryPath)
    await mkdir(targetDirectory, { recursive: true })
    const directoryInfo = await stat(targetDirectory)
    if (!directoryInfo.isDirectory()) throw new Error('目标位置不是文件夹')
    const sourceExtension = extname(source).toLowerCase() || '.png'
    const stem = cleanFileStem(basename(source, sourceExtension))
    for (let index = 0; index < 1_000; index += 1) {
      const name = `${stem}${index === 0 ? '' : `-${index + 1}`}${sourceExtension}`
      const target = join(targetDirectory, name)
      try {
        await copyFile(source, target, constants.COPYFILE_EXCL)
        return { path: target, name }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error('目标文件夹内同名图片过多')
  }

  async persistToDocument(sourcePath: string, documentPath: string): Promise<ImageGenerationPersistResult> {
    if (!isAbsolute(documentPath)) throw new Error('请先保存文档再插入生成图片')
    const assetsDirectory = join(dirname(resolve(documentPath)), 'assets')
    const result = await this.copyUnique(sourcePath, assetsDirectory)
    return { ...result, relativePath: `assets/${result.name}` }
  }

  async persistToDirectory(sourcePath: string, directoryPath: string): Promise<ImageGenerationPersistResult> {
    if (!isAbsolute(directoryPath)) throw new Error('目标文件夹路径无效')
    return this.copyUnique(sourcePath, directoryPath)
  }
}

let sharedImageGenerationService: ImageGenerationService | null = null

export function getImageGenerationService(): ImageGenerationService {
  if (!sharedImageGenerationService) sharedImageGenerationService = new ImageGenerationService()
  return sharedImageGenerationService
}

export function resetImageGenerationServiceForTests(): void {
  sharedImageGenerationService = null
}
