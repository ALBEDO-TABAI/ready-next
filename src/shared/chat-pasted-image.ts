export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024

export interface PastedImageFile {
  name: string
  path: string
  type: 'image'
  size: number
  ext: '.png'
}
