import { clipboard, ipcMain, nativeImage } from 'electron'
import type {
  ImageGenerationCopyInput,
  ImageGenerationIpcResult,
  ImageGenerationPersistResult,
  ImageGenerationPersistToDirectoryInput,
  ImageGenerationPersistToDocumentInput,
} from '../../../shared/image-generation'
import { getImageGenerationService } from './image-generation-service'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function setupImageGenerationIPC(): void {
  const service = getImageGenerationService()
  ipcMain.removeHandler('imageGeneration:persistToDocument')
  ipcMain.removeHandler('imageGeneration:persistToDirectory')
  ipcMain.removeHandler('imageGeneration:copyToClipboard')

  ipcMain.handle(
    'imageGeneration:persistToDocument',
    async (_event, input: ImageGenerationPersistToDocumentInput): Promise<ImageGenerationIpcResult<ImageGenerationPersistResult>> => {
      try {
        const data = await service.persistToDocument(input?.sourcePath, input?.documentPath)
        return { success: true, data }
      } catch (error) {
        return { success: false, error: errorMessage(error) }
      }
    },
  )

  ipcMain.handle(
    'imageGeneration:persistToDirectory',
    async (_event, input: ImageGenerationPersistToDirectoryInput): Promise<ImageGenerationIpcResult<ImageGenerationPersistResult>> => {
      try {
        const data = await service.persistToDirectory(input?.sourcePath, input?.directoryPath)
        return { success: true, data }
      } catch (error) {
        return { success: false, error: errorMessage(error) }
      }
    },
  )

  ipcMain.handle(
    'imageGeneration:copyToClipboard',
    async (_event, input: ImageGenerationCopyInput): Promise<ImageGenerationIpcResult> => {
      try {
        const bytes = await service.readCachedImage(input?.sourcePath)
        const image = nativeImage.createFromBuffer(Buffer.from(bytes))
        if (image.isEmpty()) throw new Error('生成图片无法读取')
        clipboard.writeImage(image)
        return { success: true }
      } catch (error) {
        return { success: false, error: errorMessage(error) }
      }
    },
  )
}
