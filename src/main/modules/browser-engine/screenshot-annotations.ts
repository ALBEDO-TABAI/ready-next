
const digits = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111']
export interface ScreenshotTarget { targetId: string; box?: { x: number; y: number; width: number; height: number }; frameId?: string }

/** Raster composition never inserts overlays into the user's DOM. */
export async function annotateBrowserScreenshot(base64: string, viewportWidth: number, targets: ScreenshotTarget[]) {
  const { nativeImage } = await import('electron')
  const source = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
  const { width, height } = source.getSize()
  const bitmap = source.toBitmap()
  const scale = width / viewportWidth
  const labels: { number: number; targetId: string }[] = []
  const pixel = (x: number, y: number, white: boolean) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    bitmap[i] = white ? 255 : 32; bitmap[i + 1] = white ? 255 : 32
    bitmap[i + 2] = white ? 255 : 220; bitmap[i + 3] = 255
  }
  targets.forEach((target, index) => {
    const box = target.box
    if (!box || (target.frameId && target.frameId !== '0') || box.width <= 0 || box.height <= 0) return
    const x = Math.round(box.x * scale), y = Math.round(box.y * scale)
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const number = index + 1, text = String(number)
    const unit = Math.max(2, Math.round(2 * scale))
    for (let yy = 0; yy < 7 * unit; yy++) for (let xx = 0; xx < (text.length * 4 + 1) * unit; xx++) pixel(x + xx, y + yy, false)
    for (let c = 0; c < text.length; c++) {
      const glyph = digits[Number(text[c])]
      for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) {
        if (glyph[row * 3 + col] !== '1') continue
        for (let dy = 0; dy < unit; dy++) for (let dx = 0; dx < unit; dx++) pixel(x + (1 + c * 4 + col) * unit + dx, y + (row + 1) * unit + dy, true)
      }
    }
    labels.push({ number, targetId: target.targetId })
  })
  return { base64: nativeImage.createFromBitmap(bitmap, { width, height }).toPNG().toString('base64'), labels }
}
