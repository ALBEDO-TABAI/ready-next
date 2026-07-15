export type ImageGenerationProtocol = 'openai-images' | 'gemini-generate-content'

export interface ImageGenerationReferenceLabel {
  order: number
  name: string
}

export interface GeneratedImageArtifactMeta {
  serviceId: string
  model: string
  protocol: ImageGenerationProtocol
  prompt: string
  referenceImages: ImageGenerationReferenceLabel[]
  temporary: true
}

export interface GeneratedImageArtifact {
  id: string
  module: 'system'
  kind: 'generated_image'
  label: string
  path: string
  mimeType: string
  createdAt: string
  meta: GeneratedImageArtifactMeta
}

export interface ImageGenerationPersistToDocumentInput {
  sourcePath: string
  documentPath: string
}

export interface ImageGenerationPersistToDirectoryInput {
  sourcePath: string
  directoryPath: string
}

export interface ImageGenerationPersistResult {
  path: string
  name: string
  relativePath?: string
}

export interface ImageGenerationCopyInput {
  sourcePath: string
}

export interface ImageGenerationIpcResult<T = undefined> {
  success: boolean
  data?: T
  error?: string
}

export const IMAGE_GENERATION_CACHE_DIR_NAME = 'ready-image-generation'
export const IMAGE_GENERATION_REFERENCE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
export const IMAGE_GENERATION_MAX_REFERENCE_COUNT = 8
export const IMAGE_GENERATION_MAX_REFERENCE_BYTES = 20 * 1024 * 1024
export const IMAGE_GENERATION_MAX_REFERENCE_TOTAL_BYTES = 64 * 1024 * 1024
export const IMAGE_GENERATION_MAX_OUTPUT_BYTES = 32 * 1024 * 1024
export const IMAGE_GENERATION_REQUEST_TIMEOUT_MS = 180_000

export function isImageGenerationReferencePath(value: string): boolean {
  const name = String(value || '').split(/[\\/]/).pop() || ''
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() || '' : ''
  return IMAGE_GENERATION_REFERENCE_EXTENSIONS.has(extension)
}
