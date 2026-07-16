import { join } from 'node:path'

const READY_WINDOW_CORNER_RADIUS = 12

interface WindowCaptureImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  toBitmap(): Buffer
}

interface CapturableWindow {
  isDestroyed(): boolean
  isFullScreen(): boolean
  isMaximized(): boolean
  isFocused?(): boolean
  getContentSize?(): number[]
  capturePage(): Promise<WindowCaptureImage>
}

interface CaptureReadyWindowOptions {
  window: CapturableWindow | null
  desktopPath: string
  now: () => Date
  platform: NodeJS.Platform
  createPngFromBitmap: (bitmap: Buffer, size: { width: number; height: number }) => Buffer
  writeFile: (path: string, data: Buffer) => Promise<unknown>
}

export interface ReadyWindowCaptureResult {
  success: boolean
  path?: string
  error?: string
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

export function formatReadyScreenshotFilename(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  return `Ready 截图 ${day} ${time}.png`
}

export function applyRoundedWindowMask(bitmap: Buffer, width: number, height: number, requestedRadius: number): Buffer {
  const output = Buffer.from(bitmap)
  const radius = Math.max(0, Math.min(Math.floor(requestedRadius), Math.floor(Math.min(width, height) / 2)))
  if (radius === 0) return output

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const left = x < radius
      const right = x >= width - radius
      const top = y < radius
      const bottom = y >= height - radius
      if ((!left && !right) || (!top && !bottom)) continue

      const centerX = left ? radius : width - radius
      const centerY = top ? radius : height - radius
      const distance = Math.hypot((x + 0.5) - centerX, (y + 0.5) - centerY)
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance))
      if (coverage >= 1) continue

      const offset = (y * width + x) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        output[offset + channel] = Math.round(output[offset + channel] * coverage)
      }
    }
  }

  return output
}

export function makeWindowSurfaceOpaque(bitmap: Buffer): Buffer {
  const output = Buffer.from(bitmap)
  for (let offset = 0; offset < output.byteLength; offset += 4) {
    const alpha = output[offset + 3]
    if (alpha === 0) {
      output[offset] = 255
      output[offset + 1] = 255
      output[offset + 2] = 255
    } else if (alpha < 255) {
      output[offset] = Math.min(255, Math.round(output[offset] * 255 / alpha))
      output[offset + 1] = Math.min(255, Math.round(output[offset + 1] * 255 / alpha))
      output[offset + 2] = Math.min(255, Math.round(output[offset + 2] * 255 / alpha))
    }
    output[offset + 3] = 255
  }
  return output
}

export function applyMacWindowControls(
  bitmap: Buffer,
  width: number,
  height: number,
  scaleFactor: number,
  isFocused: boolean,
): Buffer {
  const output = Buffer.from(bitmap)
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
  const centers = [20, 40, 60].map((value) => value * scale)
  const centerY = 20 * scale
  const radius = 6 * scale
  const activeColors = [
    { red: 255, green: 95, blue: 87 },
    { red: 254, green: 188, blue: 46 },
    { red: 40, green: 200, blue: 64 },
  ]
  const inactiveColor = { red: 198, green: 198, blue: 198 }

  centers.forEach((centerX, index) => {
    const color = isFocused ? activeColors[index] : inactiveColor
    const minX = Math.max(0, Math.floor(centerX - radius - 1))
    const maxX = Math.min(width - 1, Math.ceil(centerX + radius + 1))
    const minY = Math.max(0, Math.floor(centerY - radius - 1))
    const maxY = Math.min(height - 1, Math.ceil(centerY + radius + 1))

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const distance = Math.hypot((x + 0.5) - centerX, (y + 0.5) - centerY)
        const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance))
        if (coverage <= 0) continue

        const offset = (y * width + x) * 4
        const inverse = 1 - coverage
        output[offset] = Math.round(output[offset] * inverse + color.blue * coverage)
        output[offset + 1] = Math.round(output[offset + 1] * inverse + color.green * coverage)
        output[offset + 2] = Math.round(output[offset + 2] * inverse + color.red * coverage)
        output[offset + 3] = Math.round(output[offset + 3] * inverse + 255 * coverage)
      }
    }
  })

  return output
}

export async function captureReadyWindow(options: CaptureReadyWindowOptions): Promise<ReadyWindowCaptureResult> {
  const target = options.window
  if (!target || target.isDestroyed()) {
    return { success: false, error: '当前没有可截取的 Ready 窗口' }
  }

  try {
    const image = await target.capturePage()
    if (image.isEmpty()) throw new Error('窗口图像为空')

    const { width, height } = image.getSize()
    const bitmap = image.toBitmap()
    if (width <= 0 || height <= 0 || bitmap.byteLength !== width * height * 4) {
      throw new Error('窗口图像尺寸异常')
    }

    const shouldRoundCorners = options.platform === 'darwin'
      && !target.isFullScreen()
      && !target.isMaximized()
    const [contentWidth] = target.getContentSize?.() ?? [width]
    const scaleFactor = contentWidth > 0 ? width / contentWidth : 1
    let outputBitmap = makeWindowSurfaceOpaque(bitmap)
    if (shouldRoundCorners) {
      outputBitmap = applyRoundedWindowMask(outputBitmap, width, height, READY_WINDOW_CORNER_RADIUS * scaleFactor)
    }
    if (shouldRoundCorners) {
      outputBitmap = applyMacWindowControls(outputBitmap, width, height, scaleFactor, target.isFocused?.() !== false)
    }
    const png = options.createPngFromBitmap(outputBitmap, { width, height })
    if (png.byteLength === 0) throw new Error('PNG 编码失败')

    const path = join(options.desktopPath, formatReadyScreenshotFilename(options.now()))
    await options.writeFile(path, png)
    return { success: true, path }
  } catch (error) {
    return {
      success: false,
      error: `截图失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
