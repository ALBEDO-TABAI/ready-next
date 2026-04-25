/**
 * Cache cleanup core tests (D1).
 *
 * Tests `clearCacheCore` with stubbed fs + mocked `clearChromiumCache` hook.
 * Asserts:
 *   - Removes the three "always" directories (Code Cache, Cache, Shared Dictionary)
 *   - Skips puppeteer-cache by default
 *   - Includes puppeteer-cache when `includePuppeteer: true`
 *   - Calls `session.clearCache()` exactly once
 *   - Errors per-directory don't abort the rest
 *   - `clearedBytes` reflects the sum measured BEFORE deletion
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Stats, Dirent } from 'node:fs'

import {
  clearCacheCore,
  CACHE_DIR_NAMES,
} from '../main/modules/app-control/cache-stats-core'

const USERDATA = '/Users/test/Library/Application Support/ready'

interface FsLayout {
  /** dir path → entries OR 'missing' OR { rmThrows: Error } */
  dirs: Record<string, Array<{ name: string; type: 'file' | 'dir' }> | 'missing'>
  /** file path → byte size */
  files: Record<string, number>
  /** dir paths whose rmSync should throw */
  rmFailures?: Record<string, Error>
}

function makeFs(layout: FsLayout) {
  const removed: string[] = []
  const rmFailures = layout.rmFailures ?? {}

  const existsSync = (p: unknown): boolean => {
    const path = typeof p === 'string' ? p : String(p)
    if (layout.dirs[path] === 'missing') return false
    return layout.dirs[path] !== undefined || layout.files[path] !== undefined
  }

  const readdirSync = (p: unknown): Dirent[] => {
    const path = typeof p === 'string' ? p : String(p)
    const entry = layout.dirs[path]
    if (!entry || entry === 'missing') {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return entry.map((e) => ({
      name: e.name,
      isFile: () => e.type === 'file',
      isDirectory: () => e.type === 'dir',
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      parentPath: path,
      path,
    } as unknown as Dirent))
  }

  const statSync = (p: unknown): Stats => {
    const path = typeof p === 'string' ? p : String(p)
    const size = layout.files[path]
    if (size === undefined) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return { size, isFile: () => true, isDirectory: () => false } as unknown as Stats
  }

  const rmSync = (p: unknown): void => {
    const path = typeof p === 'string' ? p : String(p)
    if (rmFailures[path]) throw rmFailures[path]
    removed.push(path)
  }

  return {
    fs: { existsSync, readdirSync, statSync, rmSync },
    removed,
  } as const
}

const codeCacheDir = `${USERDATA}/${CACHE_DIR_NAMES.codeCache}`
const cacheDir = `${USERDATA}/${CACHE_DIR_NAMES.cache}`
const sharedDir = `${USERDATA}/${CACHE_DIR_NAMES.sharedCache}`
const puppeteerDir = `${USERDATA}/${CACHE_DIR_NAMES.puppeteerCache}`

test('clearCacheCore removes 3 default directories and calls session.clearCache', async () => {
  const { fs, removed } = makeFs({
    dirs: {
      [codeCacheDir]: [{ name: 'a.bin', type: 'file' }],
      [cacheDir]: [{ name: 'b.bin', type: 'file' }],
      [sharedDir]: [{ name: 'c.bin', type: 'file' }],
      [puppeteerDir]: [{ name: 'd.bin', type: 'file' }],
    },
    files: {
      [`${codeCacheDir}/a.bin`]: 100,
      [`${cacheDir}/b.bin`]: 200,
      [`${sharedDir}/c.bin`]: 300,
      [`${puppeteerDir}/d.bin`]: 999_999, // should NOT be removed in default mode
    },
  })
  let clearChromiumCalled = 0
  const result = await clearCacheCore({
    userDataPath: USERDATA,
    fs,
    clearChromiumCache: async () => { clearChromiumCalled++ },
    logger: () => {},
  })
  assert.equal(clearChromiumCalled, 1, 'session.clearCache should be called exactly once')
  assert.deepEqual(removed.sort(), [codeCacheDir, cacheDir, sharedDir].sort())
  assert.ok(!removed.includes(puppeteerDir), 'puppeteer-cache must NOT be removed by default')
  assert.equal(result.clearedBytes, 100 + 200 + 300)
  assert.deepEqual(result.errors, [])
})

test('clearCacheCore with includePuppeteer also removes puppeteer-cache', async () => {
  const { fs, removed } = makeFs({
    dirs: {
      [codeCacheDir]: [{ name: 'a.bin', type: 'file' }],
      [cacheDir]: [{ name: 'b.bin', type: 'file' }],
      [sharedDir]: [{ name: 'c.bin', type: 'file' }],
      [puppeteerDir]: [{ name: 'd.bin', type: 'file' }],
    },
    files: {
      [`${codeCacheDir}/a.bin`]: 100,
      [`${cacheDir}/b.bin`]: 200,
      [`${sharedDir}/c.bin`]: 300,
      [`${puppeteerDir}/d.bin`]: 5000,
    },
  })
  const result = await clearCacheCore({
    userDataPath: USERDATA,
    includePuppeteer: true,
    fs,
    clearChromiumCache: async () => {},
    logger: () => {},
  })
  assert.deepEqual(removed.sort(), [codeCacheDir, cacheDir, sharedDir, puppeteerDir].sort())
  assert.equal(result.clearedBytes, 100 + 200 + 300 + 5000)
  assert.deepEqual(result.errors, [])
})

test('clearCacheCore skips missing directories silently', async () => {
  const { fs, removed } = makeFs({
    dirs: {
      [codeCacheDir]: [{ name: 'a.bin', type: 'file' }],
      [cacheDir]: 'missing',
      [sharedDir]: 'missing',
    },
    files: {
      [`${codeCacheDir}/a.bin`]: 50,
    },
  })
  const result = await clearCacheCore({
    userDataPath: USERDATA,
    fs,
    clearChromiumCache: async () => {},
    logger: () => {},
  })
  assert.deepEqual(removed, [codeCacheDir])
  assert.equal(result.clearedBytes, 50)
  assert.deepEqual(result.errors, [])
})

test('clearCacheCore reports rmSync failures but continues with other dirs', async () => {
  const { fs, removed } = makeFs({
    dirs: {
      [codeCacheDir]: [{ name: 'a.bin', type: 'file' }],
      [cacheDir]: [{ name: 'b.bin', type: 'file' }],
      [sharedDir]: [{ name: 'c.bin', type: 'file' }],
    },
    files: {
      [`${codeCacheDir}/a.bin`]: 100,
      [`${cacheDir}/b.bin`]: 200,
      [`${sharedDir}/c.bin`]: 300,
    },
    rmFailures: {
      [cacheDir]: new Error('EBUSY'),
    },
  })
  const result = await clearCacheCore({
    userDataPath: USERDATA,
    fs,
    clearChromiumCache: async () => {},
    logger: () => {},
  })
  // Code Cache + Shared Dictionary removed; Cache failed
  assert.deepEqual(removed.sort(), [codeCacheDir, sharedDir].sort())
  // clearedBytes reflects only the successful removes (100 + 300 = 400)
  assert.equal(result.clearedBytes, 100 + 300)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /rm cache: EBUSY/)
})

test('clearCacheCore reports session.clearCache failure but still removes dirs', async () => {
  const { fs, removed } = makeFs({
    dirs: {
      [codeCacheDir]: [{ name: 'a.bin', type: 'file' }],
      [cacheDir]: 'missing',
      [sharedDir]: 'missing',
    },
    files: {
      [`${codeCacheDir}/a.bin`]: 100,
    },
  })
  const result = await clearCacheCore({
    userDataPath: USERDATA,
    fs,
    clearChromiumCache: async () => { throw new Error('session unavailable') },
    logger: () => {},
  })
  assert.deepEqual(removed, [codeCacheDir])
  assert.equal(result.clearedBytes, 100)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /session\.clearCache: session unavailable/)
})

test('clearCacheCore works without a clearChromiumCache hook', async () => {
  const { fs, removed } = makeFs({
    dirs: {
      [codeCacheDir]: [{ name: 'a.bin', type: 'file' }],
      [cacheDir]: 'missing',
      [sharedDir]: 'missing',
    },
    files: {
      [`${codeCacheDir}/a.bin`]: 75,
    },
  })
  const result = await clearCacheCore({
    userDataPath: USERDATA,
    fs,
    logger: () => {},
  })
  assert.deepEqual(removed, [codeCacheDir])
  assert.equal(result.clearedBytes, 75)
  assert.deepEqual(result.errors, [])
})

test('clearCacheCore returns zero clearedBytes for fresh install (all missing)', async () => {
  const { fs, removed } = makeFs({
    dirs: {
      [codeCacheDir]: 'missing',
      [cacheDir]: 'missing',
      [sharedDir]: 'missing',
      [puppeteerDir]: 'missing',
    },
    files: {},
  })
  let clearChromiumCalled = 0
  const result = await clearCacheCore({
    userDataPath: USERDATA,
    includePuppeteer: true,
    fs,
    clearChromiumCache: async () => { clearChromiumCalled++ },
    logger: () => {},
  })
  assert.equal(removed.length, 0)
  assert.equal(result.clearedBytes, 0)
  assert.equal(clearChromiumCalled, 1, 'session.clearCache still called even with no fs cleanup')
  assert.deepEqual(result.errors, [])
})
