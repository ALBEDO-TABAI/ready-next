import { nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_PASTED_IMAGE_BYTES, type PastedImageFile } from '../../../shared/chat-pasted-image'

export async function savePastedImage(userData: string, bytes: Uint8Array): Promise<PastedImageFile> {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error('剪贴板中没有可用的图片')
  if (bytes.byteLength > MAX_PASTED_IMAGE_BYTES) throw new Error('图片不能超过 20 MB')
  const image = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (image.isEmpty()) throw new Error('无法读取这张图片，请重新复制后粘贴')
  const png = image.toPNG()
  if (png.length > MAX_PASTED_IMAGE_BYTES) throw new Error('图片不能超过 20 MB')
  // Keep file-backed attachments across restart/history; never persist base64 in messages.
  const directory = join(userData, 'chat-attachments', 'pasted')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${randomUUID()}.png`)
  await writeFile(path, png, { flag: 'wx', mode: 0o600 })
  return { name: '粘贴图片.png', path, type: 'image', size: png.length, ext: '.png' }
}
