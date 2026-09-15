import { createContext } from 'react'

export interface BookImageSize {
  width: number
  height: number
}

export interface BookImagePageSize {
  contentWidth: number
  contentHeight: number
  fontSize: number
}

export const BookImageContext = createContext<BookImagePageSize & {
  sizes: ReadonlyMap<string, BookImageSize>
  notePath?: string | null
}>({ contentWidth: 380, contentHeight: 500, fontSize: 15, sizes: new Map() })

export const BookImageParagraphContext = createContext(false)

/** 独立大图占满一张正文盒；其余图片给段落及图后间距留出空间。 */
export function resolveBookImageLayout(size: BookImageSize, page: BookImagePageSize, standalone: boolean) {
  const widthScale = Math.min(1, page.contentWidth / size.width)
  const fullPage = standalone && size.height * widthScale >= page.contentHeight / 2
  const availableHeight = Math.max(1, page.contentHeight - (fullPage ? 0 : page.fontSize * 1.6))
  const scale = Math.min(widthScale, availableHeight / size.height)
  const height = size.height * scale
  return { width: height * size.width / size.height, height, fullPage }
}

/** 冻结本次正文的图片尺寸；失败也必须终结等待，卸载后不再返回可发布结果。 */
export async function prepareBookImages(
  flow: HTMLElement,
  signal: AbortSignal,
): Promise<Map<string, BookImageSize> | null> {
  const images = Array.from(flow.querySelectorAll<HTMLImageElement>('img[data-book-image-src]'))
  await Promise.all(images.map(image => new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      clearTimeout(timer)
      image.removeEventListener('load', finish)
      image.removeEventListener('error', finish)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    if (image.complete || signal.aborted) { finish(); return }
    image.addEventListener('load', finish)
    image.addEventListener('error', finish)
    signal.addEventListener('abort', finish, { once: true })
    // 无响应的图片不能让整本书永久停在排版中；超时后本轮保留失败占位。
    timer = setTimeout(finish, 10_000)
  })))
  if (signal.aborted) return null
  return new Map(images.map(image => [image.dataset.bookImageSrc!, {
    width: image.naturalWidth,
    height: image.naturalHeight,
  }]))
}
