/**
 * Cache stats core tests (D1).
 *
 * We import the pure `getCacheStatsCore` and `walkDirSize` (not the IPC
 * wrapper) to avoid pulling in `electron` from the test process. fs is
 * stubbed via injectable seams so we can simulate userData layouts
 * deterministically.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { sep } from 'node:path'
import type { Stats, Dirent } from 'node:fs'

import {
  getCacheStatsCore,
  walkDirSize,
  CACHE_DIR_NAMES,
} from '../main/modules/app-control/cache-stats-core'

const USERDATA = '/Users/test/Library/Application Support/ready'

interface FsLayout {
  /** Map: dir path → list of entries (or 'missing' to mark non-existent). */
  dirs: Record<string, Array<{ name: string; type: 'file' | 'dir' | 'symlink' }> | 'missing'>
  /** Map: file path → byte size. */
  files: Record<string, number>
}

function makeFs(layout: FsLayout) {
  const existsSync = (p: unknown): boolean => {
    const path = String(p).split(sep).join('/')
    if (layout.dirs[path] === 'missing') return false
    if (layout.dirs[path] !== undefined) return true
    if (layout.files[path] !== undefined) return true
    return false
  }

  const readdirSync = (p: unknown, _opts?: unknown): Dirent[] => {
    const path = String(p).split(sep).join('/')
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
      isSymbolicLink: () => e.type === 'symlink',
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      // Node 20 fs.Dirent extras — only required-ish fields.
      parentPath: path,
      path,
    } as unknown as Dirent))
  }

  const statSync = (p: unknown): Stats => {
    const path = String(p).split(sep).join('/')
    const size = layout.files[path]
    if (size === undefined) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return { size, isFile: () => true, isDirectory: () => false } as unknown as Stats
  }

  const removed: string[] = []
  const rmSync = (p: unknown, _opts?: unknown): void => {
    const path = String(p).split(sep).join('/')
    removed.push(path)
  }

  return {
    fs: { existsSync, readdirSync, statSync, rmSync },
    removed,
  } as const
}

test('walkDirSize returns 0 for missing directory', () => {
  const { fs } = makeFs({
    dirs: { '/missing': 'missing' },
    files: {},
  })
  // ↓ The seams type uses real fs signatures; cast through unknown.
  const total = walkDirSize('/missing', fs as unknown as Parameters<typeof walkDirSize>[1])
  assert.equal(total, 0)
})

test('walkDirSize sums regular files at top level', () => {
  const dir = `${USERDATA}/${CACHE_DIR_NAMES.cache}`
  const { fs } = makeFs({
    dirs: {
      [dir]: [
        { name: 'a.bin', type: 'file' },
        { name: 'b.bin', type: 'file' },
      ],
    },
    files: {
      [`${dir}/a.bin`]: 100,
      [`${dir}/b.bin`]: 250,
    },
  })
  const total = walkDirSize(dir, fs as unknown as Parameters<typeof walkDirSize>[1])
  assert.equal(total, 350)
})

test('walkDirSize recurses through subdirectories', () => {
  const root = `${USERDATA}/${CACHE_DIR_NAMES.codeCache}`
  const sub1 = `${root}/js`
  const sub2 = `${root}/js/v8`
  const { fs } = makeFs({
    dirs: {
      [root]: [
        { name: 'index', type: 'file' },
        { name: 'js', type: 'dir' },
      ],
      [sub1]: [
        { name: 'compiled.bin', type: 'file' },
        { name: 'v8', type: 'dir' },
      ],
      [sub2]: [
        { name: 'snap.bin', type: 'file' },
      ],
    },
    files: {
      [`${root}/index`]: 10,
      [`${sub1}/compiled.bin`]: 1000,
      [`${sub2}/snap.bin`]: 5000,
    },
  })
  const total = walkDirSize(root, fs as unknown as Parameters<typeof walkDirSize>[1])
  assert.equal(total, 6010)
})

test('walkDirSize skips symlinks (does not follow)', () => {
  const root = `${USERDATA}/cache-with-link`
  const { fs } = makeFs({
    dirs: {
      [root]: [
        { name: 'real.bin', type: 'file' },
        { name: 'link-to-other', type: 'symlink' }, // not file, not dir → ignored
      ],
    },
    files: {
      [`${root}/real.bin`]: 999,
    },
  })
  const total = walkDirSize(root, fs as unknown as Parameters<typeof walkDirSize>[1])
  assert.equal(total, 999)
})

test('walkDirSize tolerates per-file stat errors', () => {
  const root = `${USERDATA}/cache-with-bad`
  const { fs } = makeFs({
    dirs: {
      [root]: [
        { name: 'good.bin', type: 'file' },
        { name: 'broken.bin', type: 'file' },
      ],
    },
    files: {
      [`${root}/good.bin`]: 42,
      // broken.bin has no size mapped → statSync throws → silently skipped
    },
  })
  const total = walkDirSize(root, fs as unknown as Parameters<typeof walkDirSize>[1])
  assert.equal(total, 42)
})

test('getCacheStatsCore aggregates all four subdirs', () => {
  const codeCache = `${USERDATA}/${CACHE_DIR_NAMES.codeCache}`
  const cache = `${USERDATA}/${CACHE_DIR_NAMES.cache}`
  const puppeteer = `${USERDATA}/${CACHE_DIR_NAMES.puppeteerCache}`
  const shared = `${USERDATA}/${CACHE_DIR_NAMES.sharedCache}`
  const { fs } = makeFs({
    dirs: {
      [codeCache]: [{ name: 'a', type: 'file' }],
      [cache]: [{ name: 'b', type: 'file' }],
      [puppeteer]: [{ name: 'c', type: 'file' }],
      [shared]: [{ name: 'd', type: 'file' }],
    },
    files: {
      [`${codeCache}/a`]: 100,
      [`${cache}/b`]: 200,
      [`${puppeteer}/c`]: 400,
      [`${shared}/d`]: 800,
    },
  })
  const stats = getCacheStatsCore(USERDATA, fs as unknown as Parameters<typeof getCacheStatsCore>[1])
  assert.deepEqual(stats, {
    codeCacheBytes: 100,
    cacheBytes: 200,
    puppeteerCacheBytes: 400,
    sharedCacheBytes: 800,
  })
})

test('getCacheStatsCore returns zeros when all subdirs missing (fresh install)', () => {
  const { fs } = makeFs({
    dirs: {
      [`${USERDATA}/${CACHE_DIR_NAMES.codeCache}`]: 'missing',
      [`${USERDATA}/${CACHE_DIR_NAMES.cache}`]: 'missing',
      [`${USERDATA}/${CACHE_DIR_NAMES.puppeteerCache}`]: 'missing',
      [`${USERDATA}/${CACHE_DIR_NAMES.sharedCache}`]: 'missing',
    },
    files: {},
  })
  const stats = getCacheStatsCore(USERDATA, fs as unknown as Parameters<typeof getCacheStatsCore>[1])
  assert.deepEqual(stats, {
    codeCacheBytes: 0,
    cacheBytes: 0,
    puppeteerCacheBytes: 0,
    sharedCacheBytes: 0,
  })
})

test('getCacheStatsCore handles partial layouts (some present, some missing)', () => {
  const codeCache = `${USERDATA}/${CACHE_DIR_NAMES.codeCache}`
  const { fs } = makeFs({
    dirs: {
      [codeCache]: [{ name: 'only.bin', type: 'file' }],
      [`${USERDATA}/${CACHE_DIR_NAMES.cache}`]: 'missing',
      [`${USERDATA}/${CACHE_DIR_NAMES.puppeteerCache}`]: 'missing',
      [`${USERDATA}/${CACHE_DIR_NAMES.sharedCache}`]: 'missing',
    },
    files: {
      [`${codeCache}/only.bin`]: 1234,
    },
  })
  const stats = getCacheStatsCore(USERDATA, fs as unknown as Parameters<typeof getCacheStatsCore>[1])
  assert.equal(stats.codeCacheBytes, 1234)
  assert.equal(stats.cacheBytes, 0)
  assert.equal(stats.puppeteerCacheBytes, 0)
  assert.equal(stats.sharedCacheBytes, 0)
})
