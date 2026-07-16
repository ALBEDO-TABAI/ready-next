import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyMacWindowControls,
  applyRoundedWindowMask,
  captureReadyWindow,
  formatReadyScreenshotFilename,
  makeWindowSurfaceOpaque,
} from '../main/modules/app-control/window-capture-service'

test('rounded window mask keeps the center opaque and cuts all four corners', () => {
  const width = 8
  const height = 6
  const bitmap = Buffer.alloc(width * height * 4, 255)
  const rounded = applyRoundedWindowMask(bitmap, width, height, 3)
  const alphaAt = (x: number, y: number) => rounded[(y * width + x) * 4 + 3]

  assert.equal(alphaAt(0, 0), 0)
  assert.equal(alphaAt(width - 1, 0), 0)
  assert.equal(alphaAt(0, height - 1), 0)
  assert.equal(alphaAt(width - 1, height - 1), 0)
  assert.equal(alphaAt(Math.floor(width / 2), Math.floor(height / 2)), 255)
  assert.ok(alphaAt(1, 0) > 0 && alphaAt(1, 0) < 255, 'edge pixel should be anti-aliased')
})

test('window surface becomes fully opaque before only the rounded corners are cut out', () => {
  const width = 8
  const height = 6
  const translucent = Buffer.alloc(width * height * 4, 255)
  for (let offset = 3; offset < translucent.byteLength; offset += 4) translucent[offset] = 96

  const opaque = makeWindowSurfaceOpaque(translucent)
  const rounded = applyRoundedWindowMask(opaque, width, height, 3)
  const alphaAt = (x: number, y: number) => rounded[(y * width + x) * 4 + 3]

  assert.equal(alphaAt(Math.floor(width / 2), Math.floor(height / 2)), 255)
  assert.equal(alphaAt(0, 0), 0)
  assert.equal(alphaAt(width - 1, height - 1), 0)
})

test('making the window opaque preserves translucent surface colors', () => {
  const premultipliedPixel = Buffer.from([48, 96, 24, 128])
  assert.deepEqual(Array.from(makeWindowSurfaceOpaque(premultipliedPixel)), [96, 191, 48, 255])
})

test('captureReadyWindow captures once, applies rounded corners, and writes a PNG to Desktop', async () => {
  const writes: Array<{ path: string; data: Buffer }> = []
  let captured = 0
  const width = 8
  const height = 6

  const result = await captureReadyWindow({
    window: {
      isDestroyed: () => false,
      isFullScreen: () => false,
      isMaximized: () => false,
      capturePage: async () => {
        captured += 1
        const bitmap = Buffer.alloc(width * height * 4, 255)
        for (let offset = 3; offset < bitmap.byteLength; offset += 4) bitmap[offset] = 96
        return {
          isEmpty: () => false,
          getSize: () => ({ width, height }),
          toBitmap: () => bitmap,
        }
      },
    },
    desktopPath: '/Desktop',
    now: () => new Date(2026, 6, 16, 14, 7, 8, 9),
    platform: 'darwin',
    createPngFromBitmap: (bitmap, size) => {
      assert.deepEqual(size, { width, height })
      assert.equal(bitmap[3], 0, 'top-left corner should be transparent before encoding')
      assert.equal(bitmap[(3 * width + 4) * 4 + 3], 255, 'window interior should be fully opaque')
      return Buffer.from('png-data')
    },
    writeFile: async (path, data) => {
      writes.push({ path, data })
    },
  })

  assert.equal(captured, 1)
  assert.equal(result.success, true)
  assert.equal(result.path, '/Desktop/Ready 截图 2026-07-16 14.07.08.009.png')
  assert.deepEqual(writes, [{ path: result.path!, data: Buffer.from('png-data') }])
})

test('captureReadyWindow leaves fullscreen captures square and reports unavailable windows', async () => {
  let cornerAlpha = -1
  const bitmap = Buffer.alloc(4 * 4 * 4, 255)
  const fullscreen = await captureReadyWindow({
    window: {
      isDestroyed: () => false,
      isFullScreen: () => true,
      isMaximized: () => false,
      capturePage: async () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 4, height: 4 }),
        toBitmap: () => bitmap,
      }),
    },
    desktopPath: '/Desktop',
    now: () => new Date('2026-07-16T00:00:00.000Z'),
    platform: 'darwin',
    createPngFromBitmap: (value) => {
      cornerAlpha = value[3]
      return Buffer.from('png')
    },
    writeFile: async () => undefined,
  })

  assert.equal(fullscreen.success, true)
  assert.equal(cornerAlpha, 255)

  const unavailable = await captureReadyWindow({
    window: null,
    desktopPath: '/Desktop',
    now: () => new Date(),
    platform: 'darwin',
    createPngFromBitmap: () => Buffer.from('png'),
    writeFile: async () => undefined,
  })
  assert.deepEqual(unavailable, { success: false, error: '当前没有可截取的 Ready 窗口' })
})

test('macOS fallback paints the three standard window controls at native positions', () => {
  const width = 80
  const height = 40
  const bitmap = Buffer.alloc(width * height * 4, 255)
  for (let offset = 3; offset < bitmap.byteLength; offset += 4) bitmap[offset] = 100
  const decorated = applyMacWindowControls(bitmap, width, height, 1, true)
  const pixelAt = (x: number, y: number) => Array.from(decorated.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))

  assert.deepEqual(pixelAt(20, 20), [87, 95, 255, 255])
  assert.deepEqual(pixelAt(40, 20), [46, 188, 254, 255])
  assert.deepEqual(pixelAt(60, 20), [64, 200, 40, 255])
})

test('screenshot filenames use local time with millisecond precision', () => {
  const date = new Date(2026, 6, 16, 14, 7, 8, 9)
  assert.equal(formatReadyScreenshotFilename(date), 'Ready 截图 2026-07-16 14.07.08.009.png')
})
