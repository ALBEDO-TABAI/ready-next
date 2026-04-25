import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { BINARY_EXTENSIONS } from '../main/modules/document-engine/binary-extensions'
import {
  decideFileForIndex,
  isLikelyTextContent,
  FileSystemAdapter,
} from '../main/modules/search-engine/adapters'

// ----- Helpers ---------------------------------------------------------------

function withTempRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'ready-file-filter-'))
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    })
}

function writeTextFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8')
}

function writeBinaryFile(path: string, bytes: number[]): void {
  writeFileSync(path, Buffer.from(bytes))
}

// fs.Stats look-alike sufficient for decideFileForIndex; we never call fs methods on it.
function fakeStat(size: number, isFile = true): { size: number; isFile(): boolean } {
  return { size, isFile: () => isFile }
}

// ----- BINARY_EXTENSIONS membership ------------------------------------------

test('BINARY_EXTENSIONS covers HEIC and HEIF', () => {
  assert.equal(BINARY_EXTENSIONS.has('.heic'), true)
  assert.equal(BINARY_EXTENSIONS.has('.heif'), true)
})

test('BINARY_EXTENSIONS covers After Effects + Tencent COS caches', () => {
  assert.equal(BINARY_EXTENSIONS.has('.aecache'), true)
  assert.equal(BINARY_EXTENSIONS.has('.aex'), true)
  assert.equal(BINARY_EXTENSIONS.has('.cos'), true)
})

test('BINARY_EXTENSIONS covers Unity packed assets', () => {
  for (const ext of ['.pak', '.unity3d', '.asset', '.meta']) {
    assert.equal(BINARY_EXTENSIONS.has(ext), true, `expected ${ext} to be blocked`)
  }
})

test('BINARY_EXTENSIONS covers compiled binaries', () => {
  for (const ext of ['.so', '.dylib', '.dll', '.pyc', '.pyo', '.class', '.o', '.obj', '.a', '.lib', '.pdb', '.exp']) {
    assert.equal(BINARY_EXTENSIONS.has(ext), true, `expected ${ext} to be blocked`)
  }
})

test('BINARY_EXTENSIONS covers disk images / installers', () => {
  for (const ext of ['.dmg', '.iso', '.pkg', '.msi', '.deb', '.rpm', '.appimage']) {
    assert.equal(BINARY_EXTENSIONS.has(ext), true, `expected ${ext} to be blocked`)
  }
})

test('BINARY_EXTENSIONS covers iWork and Office binaries', () => {
  for (const ext of ['.pdf', '.pptx', '.xlsx', '.docx', '.keynote', '.pages', '.numbers']) {
    assert.equal(BINARY_EXTENSIONS.has(ext), true, `expected ${ext} to be blocked`)
  }
})

test('BINARY_EXTENSIONS covers RAW image formats', () => {
  for (const ext of ['.raw', '.cr2', '.nef', '.arw', '.dng', '.psd', '.ai', '.eps']) {
    assert.equal(BINARY_EXTENSIONS.has(ext), true, `expected ${ext} to be blocked`)
  }
})

test('BINARY_EXTENSIONS keeps legitimate text extensions out', () => {
  for (const ext of ['.md', '.txt', '.json', '.ts', '.tsx', '.js', '.html', '.css', '.yaml', '.yml']) {
    assert.equal(BINARY_EXTENSIONS.has(ext), false, `expected ${ext} to NOT be blocked`)
  }
})

// ----- decideFileForIndex extension/path/size --------------------------------

test('decideFileForIndex rejects .heic by extension', async () => {
  await withTempRoot(async (root) => {
    const path = join(root, 'photo.heic')
    writeBinaryFile(path, [0x00, 0x01, 0x02])
    const decision = await decideFileForIndex(path, fakeStat(3))
    assert.equal(decision.accept, false)
    if (!decision.accept) assert.equal(decision.reason, 'binary_ext')
  })
})

test('decideFileForIndex rejects .pak / .so / .pdf by extension', async () => {
  await withTempRoot(async (root) => {
    for (const name of ['game.pak', 'lib.so', 'spec.pdf']) {
      const path = join(root, name)
      writeBinaryFile(path, [0xff, 0xfe])
      const decision = await decideFileForIndex(path, fakeStat(2))
      assert.equal(decision.accept, false, `expected ${name} to be rejected`)
      if (!decision.accept) assert.equal(decision.reason, 'binary_ext')
    }
  })
})

test('decideFileForIndex rejects 6MB markdown by size cap', async () => {
  await withTempRoot(async (root) => {
    const path = join(root, 'huge.md')
    // We don't actually write 6MB to disk — just synthesise the stat.
    const decision = await decideFileForIndex(path, fakeStat(6 * 1024 * 1024))
    assert.equal(decision.accept, false)
    if (!decision.accept) assert.equal(decision.reason, 'oversized')
  })
})

test('decideFileForIndex accepts 4MB markdown (under the 5MB cap)', async () => {
  await withTempRoot(async (root) => {
    const path = join(root, 'big-but-ok.md')
    writeTextFile(path, 'hello world')
    const decision = await decideFileForIndex(path, fakeStat(4 * 1024 * 1024))
    assert.equal(decision.accept, true)
  })
})

// ----- Binary content sniff for ext-less files -------------------------------

test('decideFileForIndex rejects ext-less file containing a NUL byte', async () => {
  await withTempRoot(async (root) => {
    const path = join(root, 'opaque-blob')
    writeBinaryFile(path, [0x68, 0x65, 0x6c, 0x6c, 0x00, 0x6f]) // "hell\0o"
    const decision = await decideFileForIndex(path, fakeStat(6))
    assert.equal(decision.accept, false)
    if (!decision.accept) assert.equal(decision.reason, 'binary_sniff')
  })
})

test('decideFileForIndex accepts ext-less UTF-8 text file', async () => {
  await withTempRoot(async (root) => {
    const path = join(root, 'README')
    writeTextFile(path, 'Hello, 世界! This is plain text.\nLine two.\n')
    const decision = await decideFileForIndex(path, fakeStat(64))
    assert.equal(decision.accept, true)
  })
})

test('decideFileForIndex rejects ext-less file with >30% control characters', async () => {
  await withTempRoot(async (root) => {
    const path = join(root, 'noisy')
    // 50% control chars (0x01), 50% printable 'A'.
    const bytes: number[] = []
    for (let i = 0; i < 100; i += 1) {
      bytes.push(i % 2 === 0 ? 0x01 : 0x41)
    }
    writeBinaryFile(path, bytes)
    const decision = await decideFileForIndex(path, fakeStat(bytes.length))
    assert.equal(decision.accept, false)
    if (!decision.accept) assert.equal(decision.reason, 'binary_sniff')
  })
})

// ----- Path segment blocklist ------------------------------------------------

test('decideFileForIndex rejects paths containing node_modules', async () => {
  await withTempRoot(async (root) => {
    const dir = join(root, 'node_modules', 'foo')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'index.js')
    writeTextFile(path, 'module.exports = 1')
    const decision = await decideFileForIndex(path, fakeStat(20))
    assert.equal(decision.accept, false)
    if (!decision.accept) assert.equal(decision.reason, 'blocked_segment')
  })
})

test('decideFileForIndex rejects paths containing .git', async () => {
  await withTempRoot(async (root) => {
    const dir = join(root, '.git', 'objects')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'pack-abc')
    writeTextFile(path, 'plain text but inside .git')
    const decision = await decideFileForIndex(path, fakeStat(30))
    assert.equal(decision.accept, false)
    if (!decision.accept) assert.equal(decision.reason, 'blocked_segment')
  })
})

test('decideFileForIndex rejects paths inside .next / dist / build / target / vendor', async () => {
  await withTempRoot(async (root) => {
    for (const blocked of ['.next', 'dist', 'build', 'target', 'vendor']) {
      const dir = join(root, blocked, 'sub')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, 'file.txt')
      writeTextFile(path, 'text')
      const decision = await decideFileForIndex(path, fakeStat(4))
      assert.equal(decision.accept, false, `expected ${blocked} to block`)
      if (!decision.accept) assert.equal(decision.reason, 'blocked_segment')
    }
  })
})

// ----- macOS bundle directory rejection (FileSystemAdapter walker) -----------

test('FileSystemAdapter.collectCandidatePaths skips .app bundle directories', async () => {
  await withTempRoot(async (root) => {
    // Workspace layout:
    //   root/
    //     ok.md
    //     MyApp.app/Contents/MacOS/binary
    writeTextFile(join(root, 'ok.md'), '# hello')
    const bundleInner = join(root, 'MyApp.app', 'Contents', 'MacOS')
    mkdirSync(bundleInner, { recursive: true })
    writeTextFile(join(bundleInner, 'binary'), 'mock binary')

    const adapter = new FileSystemAdapter()
    // collectCandidatePaths is private — exercise through loadOne probes.
    // Easier path: drive reindex via a stub repository and inspect the scanned
    // file list via loadOne against the inner binary (should be filterable),
    // and verify the .app dir is not walked. We assert by building an index
    // through a minimal repo stub.
    const indexedPaths: string[] = []
    const stubRepo = makeStubRepository(indexedPaths)
    const result = await adapter.reindex({
      workspaceId: 1,
      workspaceRoot: root,
      repository: stubRepo,
    })
    assert.equal(result.scanned, 1, 'only ok.md should have been scanned')
    assert.equal(indexedPaths.length, 1)
    assert.equal(indexedPaths[0].endsWith('ok.md'), true)
    // Sanity: nothing inside the .app bundle made it through.
    assert.equal(
      indexedPaths.some((p) => p.includes('MyApp.app')),
      false,
      'no path inside MyApp.app should be indexed',
    )
  })
})

test('FileSystemAdapter.collectCandidatePaths skips node_modules + .git', async () => {
  await withTempRoot(async (root) => {
    writeTextFile(join(root, 'README.md'), 'top-level readme')
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeTextFile(join(root, 'node_modules', 'pkg', 'index.js'), 'should never be indexed')
    mkdirSync(join(root, '.git', 'objects'), { recursive: true })
    writeTextFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')

    const adapter = new FileSystemAdapter()
    const indexedPaths: string[] = []
    const stubRepo = makeStubRepository(indexedPaths)
    const result = await adapter.reindex({
      workspaceId: 1,
      workspaceRoot: root,
      repository: stubRepo,
    })
    assert.equal(result.scanned, 1, 'only README.md should be scanned')
    assert.equal(indexedPaths.length, 1)
    assert.equal(indexedPaths[0].endsWith('README.md'), true)
  })
})

// ----- isLikelyTextContent unit tests ----------------------------------------

test('isLikelyTextContent: empty buffer is text', () => {
  assert.equal(isLikelyTextContent(Buffer.alloc(0)), true)
})

test('isLikelyTextContent: NUL byte is binary', () => {
  assert.equal(isLikelyTextContent(Buffer.from([0x68, 0x00, 0x69])), false)
})

test('isLikelyTextContent: plain ASCII is text', () => {
  assert.equal(isLikelyTextContent(Buffer.from('Hello world\n', 'utf-8')), true)
})

test('isLikelyTextContent: UTF-8 multibyte is text', () => {
  assert.equal(isLikelyTextContent(Buffer.from('你好，世界！\n', 'utf-8')), true)
})

test('isLikelyTextContent: tab/newline/cr do not count as control', () => {
  // 100 bytes, all 9/10/13 — should pass the 30% threshold.
  const bytes: number[] = []
  for (let i = 0; i < 100; i += 1) bytes.push([9, 10, 13][i % 3])
  assert.equal(isLikelyTextContent(Buffer.from(bytes)), true)
})

test('isLikelyTextContent: 50% control chars is binary', () => {
  const bytes: number[] = []
  for (let i = 0; i < 100; i += 1) bytes.push(i % 2 === 0 ? 0x01 : 0x41)
  assert.equal(isLikelyTextContent(Buffer.from(bytes)), false)
})

// ----- Stub repository for FileSystemAdapter tests ---------------------------

function makeStubRepository(indexedPaths: string[]): import('../main/modules/search-engine/repository').SearchRepository {
  let nextId = 1
  // We only need the methods reindex actually calls. Casts intentionally
  // narrow — a full implementation lives in repository.ts.
  const stub = {
    listPathsForWorkspace(): Array<{ id: number; path: string }> {
      return []
    },
    upsertDocument(payload: { path: string }) {
      indexedPaths.push(payload.path)
      return { documentId: nextId++, skipped: false }
    },
    replaceTags() {},
    replaceLinks() {},
    replaceAttachments() {},
    deletePath() {},
    resolveWikilinkTargets() {},
    transaction(fn: () => void) {
      fn()
    },
    getConnection(): never {
      throw new Error('getConnection not used in this test')
    },
  }
  return stub as unknown as import('../main/modules/search-engine/repository').SearchRepository
}
