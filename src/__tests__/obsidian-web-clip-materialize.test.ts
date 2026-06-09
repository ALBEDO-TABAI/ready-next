/**
 * Materialize-to-vault contract tests.
 *
 * `materializeToVault` is the move-semantics step that converts a sandboxed
 * .md (with remote image URLs) into a self-contained `<note>/` folder in the
 * user's vault folder. These tests run with in-memory deps so we don't touch
 * the filesystem or the network.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  MaterializeError,
  formatLocalPathForMarkdown,
  inferExtension,
  materializeToVault,
  stripUnfetchableImageRefs,
  type MaterializeDeps,
} from '../main/modules/clipping/materialize-to-vault'

function makeMemoryDeps(overrides?: {
  initialMd?: string
  imageBytesByUrl?: Record<string, { bytes: Uint8Array; contentType: string }>
  failFetchFor?: Set<string>
}): {
  deps: MaterializeDeps
  writtenFiles: Map<string, string | Uint8Array>
  ensuredDirs: Set<string>
  unlinkedPaths: Set<string>
  fetchedUrls: string[]
  fetchedMaxBytes: number[]
} {
  const writtenFiles = new Map<string, string | Uint8Array>()
  const ensuredDirs = new Set<string>()
  const unlinkedPaths = new Set<string>()
  const fetchedUrls: string[] = []
  const fetchedMaxBytes: number[] = []
  const dirs = new Set<string>(['/Users/me/Notes', '/Users/me', '/Users'])
  if (overrides?.initialMd !== undefined) {
    writtenFiles.set('/sandbox/note.md', overrides.initialMd)
  }
  const deps: MaterializeDeps = {
    readMarkdown: async (path) => {
      const v = writtenFiles.get(path)
      if (typeof v === 'string') return v
      if (v instanceof Uint8Array) return new TextDecoder().decode(v)
      throw new Error(`ENOENT: ${path}`)
    },
    unlink: async (path) => {
      writtenFiles.delete(path)
      unlinkedPaths.add(path)
    },
    ensureDir: async (path) => {
      ensuredDirs.add(path)
      dirs.add(path)
    },
    writeFile: async (path, content) => {
      writtenFiles.set(path, content)
    },
    statIsDirectory: async (path) => {
      if (dirs.has(path)) return true
      if (writtenFiles.has(path)) return false
      throw new Error(`ENOENT: ${path}`)
    },
    fetchImage: async (url, options) => {
      fetchedUrls.push(url)
      fetchedMaxBytes.push(options.maxBytes)
      if (overrides?.failFetchFor?.has(url)) return null
      const direct = overrides?.imageBytesByUrl?.[url]
      if (direct) return direct
      return {
        bytes: new TextEncoder().encode(`fake-bytes-for-${url}`),
        contentType: 'image/jpeg',
      }
    },
    joinPath: (...segs) => segs.join('/').replace(/\/+/g, '/'),
    basename: (p) => p.split('/').pop() || '',
    isAbsolute: (p) => p.startsWith('/'),
  }
  return { deps, writtenFiles, ensuredDirs, unlinkedPaths, fetchedUrls, fetchedMaxBytes }
}

function tinyWebpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  bytes.set([0x16, 0x00, 0x00, 0x00], 4)
  bytes.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
  bytes.set([0x0a, 0x00, 0x00, 0x00], 16)
  const widthMinusOne = width - 1
  const heightMinusOne = height - 1
  bytes[24] = widthMinusOne & 0xff
  bytes[25] = (widthMinusOne >> 8) & 0xff
  bytes[26] = (widthMinusOne >> 16) & 0xff
  bytes[27] = heightMinusOne & 0xff
  bytes[28] = (heightMinusOne >> 8) & 0xff
  bytes[29] = (heightMinusOne >> 16) & 0xff
  return bytes
}

describe('materializeToVault · invalid target', () => {
  it('throws MaterializeError(invalid_target) on empty target_dir', async () => {
    const { deps } = makeMemoryDeps({ initialMd: '# hi' })
    await assert.rejects(
      () =>
        materializeToVault(
          { sandboxMdPath: '/sandbox/note.md', targetDir: '' },
          deps,
        ),
      (err: unknown) => err instanceof MaterializeError && err.kind === 'invalid_target',
    )
  })

  it('throws invalid_target when target_dir is relative', async () => {
    const { deps } = makeMemoryDeps({ initialMd: '# hi' })
    await assert.rejects(
      () =>
        materializeToVault(
          { sandboxMdPath: '/sandbox/note.md', targetDir: 'Notes' },
          deps,
        ),
      (err: unknown) => err instanceof MaterializeError && err.kind === 'invalid_target',
    )
  })

  it('throws not_a_directory when target_dir is actually a file', async () => {
    const { deps, writtenFiles } = makeMemoryDeps({ initialMd: '# hi' })
    writtenFiles.set('/Users/me/somefile.md', 'a file')
    await assert.rejects(
      () =>
        materializeToVault(
          { sandboxMdPath: '/sandbox/note.md', targetDir: '/Users/me/somefile.md' },
          deps,
        ),
      (err: unknown) => err instanceof MaterializeError && err.kind === 'not_a_directory',
    )
  })

  it('throws sandbox_read_failed when source .md is missing', async () => {
    const { deps } = makeMemoryDeps()
    await assert.rejects(
      () =>
        materializeToVault(
          { sandboxMdPath: '/sandbox/missing.md', targetDir: '/Users/me/Notes' },
          deps,
        ),
      (err: unknown) => err instanceof MaterializeError && err.kind === 'sandbox_read_failed',
    )
  })
})

describe('materializeToVault · move semantics + image bundling', () => {
  it('downloads images, rewrites refs to relative path, writes final .md, unlinks sandbox', async () => {
    const initialMd = [
      '# Title',
      '',
      '![Hero](https://cdn.example.com/hero.jpg)',
      '',
      'Some body text.',
      '',
      '![](https://cdn.example.com/inline.png)',
    ].join('\n')
    const { deps, writtenFiles, unlinkedPaths, ensuredDirs, fetchedUrls, fetchedMaxBytes } = makeMemoryDeps({
      initialMd,
      imageBytesByUrl: {
        'https://cdn.example.com/hero.jpg': {
          bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
          contentType: 'image/jpeg',
        },
        'https://cdn.example.com/inline.png': {
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          contentType: 'image/png',
        },
      },
    })

    const result = await materializeToVault(
      { sandboxMdPath: '/sandbox/note.md', targetDir: '/Users/me/Notes' },
      deps,
    )

    assert.equal(result.finalMdPath, '/Users/me/Notes/note/note.md')
    assert.ok(ensuredDirs.has('/Users/me/Notes/note/note.assets'), 'assets dir must be ensured')
    assert.equal(result.assetPaths.length, 2, `expected 2 asset paths, got ${result.assetPaths.length}`)
    assert.equal(result.imageDownloadFailures, 0)
    assert.equal(fetchedUrls.length, 2)
    assert.deepEqual(fetchedMaxBytes, [64 * 1024 * 1024, 64 * 1024 * 1024])
    assert.ok(unlinkedPaths.has('/sandbox/note.md'), 'sandbox file must be unlinked (move semantics)')

    const finalMd = writtenFiles.get('/Users/me/Notes/note/note.md')
    assert.equal(typeof finalMd, 'string')
    const md = String(finalMd)
    assert.ok(!md.includes('https://cdn.example.com/'), 'remote URLs must be rewritten away')
    assert.match(md, /!\[Hero\]\(note\.assets\/[0-9a-f]+\.jpg\)/, 'hero image rewritten to relative path')
    assert.match(md, /!\[\]\(note\.assets\/[0-9a-f]+\.png\)/, 'inline image rewritten to relative path')
  })

  it('keeps remote URL in markdown when an image download fails', async () => {
    const initialMd = [
      '# Title',
      '',
      '![Good](https://cdn.example.com/good.jpg)',
      '',
      '![Bad](https://cdn.example.com/bad.jpg)',
    ].join('\n')
    const failing = new Set(['https://cdn.example.com/bad.jpg'])
    const { deps, writtenFiles } = makeMemoryDeps({
      initialMd,
      failFetchFor: failing,
    })

    const result = await materializeToVault(
      { sandboxMdPath: '/sandbox/note.md', targetDir: '/Users/me/Notes' },
      deps,
    )

    assert.equal(result.imageDownloadFailures, 1)
    assert.equal(result.assetPaths.length, 1)
    const md = String(writtenFiles.get('/Users/me/Notes/note/note.md'))
    assert.match(md, /!\[Good\]\(note\.assets\/[0-9a-f]+\.jpg\)/)
    assert.match(md, /!\[Bad\]\(https:\/\/cdn\.example\.com\/bad\.jpg\)/, 'failed download keeps remote URL')
  })

  it('treats a text/html response for a jpg URL as a failed image download', async () => {
    const initialMd = [
      '# Weibo',
      '',
      '![Main](https://wx1.sinaimg.cn/large/example.jpg)',
    ].join('\n')
    const { deps, writtenFiles } = makeMemoryDeps({
      initialMd,
      imageBytesByUrl: {
        'https://wx1.sinaimg.cn/large/example.jpg': {
          bytes: new TextEncoder().encode('<html>blocked</html>'),
          contentType: 'text/html; charset=utf-8',
        },
      },
    })

    const result = await materializeToVault(
      { sandboxMdPath: '/sandbox/note.md', targetDir: '/Users/me/Notes' },
      deps,
    )

    assert.equal(result.imageDownloadFailures, 1)
    assert.equal(result.assetPaths.length, 0)
    assert.match(result.failureMessages[0] || '', /non-image response/)
    const md = String(writtenFiles.get('/Users/me/Notes/note/note.md'))
    assert.match(md, /!\[Main\]\(https:\/\/wx1\.sinaimg\.cn\/large\/example\.jpg\)/)
  })

  it('dedupes identical URLs so each image is downloaded only once', async () => {
    const initialMd = [
      '![One](https://cdn.example.com/same.jpg)',
      '',
      '![Two](https://cdn.example.com/same.jpg)',
      '',
      '![Three](https://cdn.example.com/same.jpg)',
    ].join('\n')
    const { deps, fetchedUrls, writtenFiles } = makeMemoryDeps({ initialMd })

    const result = await materializeToVault(
      { sandboxMdPath: '/sandbox/note.md', targetDir: '/Users/me/Notes' },
      deps,
    )

    assert.equal(fetchedUrls.length, 1, 'same URL must be fetched once')
    assert.equal(result.assetPaths.length, 1)
    const md = String(writtenFiles.get('/Users/me/Notes/note/note.md'))
    const matches = md.match(/note\.assets\/[0-9a-f]+\.jpg/g) || []
    assert.equal(matches.length, 3, 'all 3 references point to the same dedup asset')
  })

  it('drops decorative footer image buttons after resource inspection', async () => {
    const initialMd = [
      '# Title',
      '',
      '![Hero](https://cdn.example.com/body.jpg)',
      '',
      '![](https://cdn.example.com/stripe.webp)',
      '',
      '[![](https://cdn.example.com/social.webp)](https://weibo.com/u/1726303567)',
    ].join('\n')
    const { deps, fetchedUrls, writtenFiles } = makeMemoryDeps({
      initialMd,
      imageBytesByUrl: {
        'https://cdn.example.com/body.jpg': {
          bytes: new TextEncoder().encode('fake-large-body-image'),
          contentType: 'image/jpeg',
        },
        'https://cdn.example.com/stripe.webp': {
          bytes: tinyWebpVp8x(1080, 33),
          contentType: 'image/webp',
        },
        'https://cdn.example.com/social.webp': {
          bytes: tinyWebpVp8x(360, 420),
          contentType: 'image/webp',
        },
      },
    })

    const result = await materializeToVault(
      { sandboxMdPath: '/sandbox/note.md', targetDir: '/Users/me/Notes' },
      deps,
    )

    assert.equal(fetchedUrls.length, 3)
    assert.equal(result.imageDownloadFailures, 0)
    assert.equal(result.assetPaths.length, 1)
    const md = String(writtenFiles.get('/Users/me/Notes/note/note.md'))
    assert.match(md, /!\[Hero\]\(note\.assets\/[0-9a-f]+\.jpg\)/)
    assert.equal(md.includes('stripe.webp'), false)
    assert.equal(md.includes('social.webp'), false)
    assert.equal(md.includes('weibo.com/u/1726303567'), false)
  })

  it('renders a no-image markdown with no asset dir created', async () => {
    const initialMd = '# Title\n\nNo images here.'
    const { deps, ensuredDirs, fetchedUrls, writtenFiles, unlinkedPaths } = makeMemoryDeps({ initialMd })
    const result = await materializeToVault(
      { sandboxMdPath: '/sandbox/note.md', targetDir: '/Users/me/Notes' },
      deps,
    )
    assert.equal(result.assetPaths.length, 0)
    assert.equal(fetchedUrls.length, 0)
    assert.ok(ensuredDirs.has('/Users/me/Notes/note'))
    assert.equal(ensuredDirs.has('/Users/me/Notes/note/note.assets'), false)
    assert.ok(unlinkedPaths.has('/sandbox/note.md'))
    assert.equal(String(writtenFiles.get('/Users/me/Notes/note/note.md')), initialMd)
  })
})

describe('materializeToVault · defense-in-depth strips blob/data refs', () => {
  it('saved .md contains no blob: / data: image refs even when sandbox had them', async () => {
    const initialMd = [
      '# Title',
      '',
      '![Hero](https://cdn.example.com/hero.jpg)',
      '',
      '![Image 6](blob:http://localhost/abc)',
      '',
      '![Image 7](blob:http://localhost/def)',
      '',
      '![placeholder](data:image/svg+xml,%3Csvg/%3E)',
      '',
      'body text',
    ].join('\n')
    const { deps, writtenFiles, fetchedUrls } = makeMemoryDeps({ initialMd })

    await materializeToVault(
      { sandboxMdPath: '/sandbox/note.md', targetDir: '/Users/me/Notes' },
      deps,
    )
    const md = String(writtenFiles.get('/Users/me/Notes/note/note.md'))
    assert.ok(!md.includes('blob:'), 'no blob: refs in saved .md')
    assert.ok(!md.includes('data:image'), 'no data: refs in saved .md')
    assert.match(md, /!\[Hero\]\(note\.assets\/[0-9a-f]+\.jpg\)/, 'real image still downloaded + rewritten')
    // Real http img was the only one fetched; the blob/data refs were
    // stripped before the download phase.
    assert.equal(fetchedUrls.length, 1, 'only fetchable refs reach the downloader')
  })
})

describe('formatLocalPathForMarkdown · preserves local asset names', () => {
  it('wraps spaces in angle-bracket markdown destination syntax', () => {
    assert.equal(
      formatLocalPathForMarkdown('Shay Mitchell.assets/x.webp'),
      '<Shay Mitchell.assets/x.webp>',
    )
  })

  it('leaves simple ASCII paths unchanged', () => {
    assert.equal(
      formatLocalPathForMarkdown('folder/subfolder/file-name.png'),
      'folder/subfolder/file-name.png',
    )
  })

  it('wraps parentheses + Chinese paths without percent-encoding the folder name', () => {
    assert.equal(
      formatLocalPathForMarkdown('弹丸论破同人插画｜整理了一些以前的摸鱼 (小红书).assets/a.jpg'),
      '<弹丸论破同人插画｜整理了一些以前的摸鱼 (小红书).assets/a.jpg>',
    )
  })

  it('leaves Chinese-only paths unwrapped for broad markdown preview compatibility', () => {
    assert.equal(
      formatLocalPathForMarkdown('二十年啦！陪MOLLY拾起沿途的风景.assets/a.jpg'),
      '二十年啦！陪MOLLY拾起沿途的风景.assets/a.jpg',
    )
  })

  it('escapes > inside an angle-bracket destination', () => {
    assert.equal(
      formatLocalPathForMarkdown('title > draft.assets/a.jpg'),
      '<title \\> draft.assets/a.jpg>',
    )
  })
})

describe('materializeToVault · markdown image refs preserve local asset folders', () => {
  it('saved .md image refs use angle brackets for path segments with spaces', async () => {
    const initialMd = '# Title\n\n![hero](https://cdn.example.com/hero.jpg)'
    const { deps, writtenFiles } = makeMemoryDeps({ initialMd })
    // Place the sandbox file at the path the test asserts on.
    writtenFiles.set('/sandbox/My note title.md', initialMd)

    await materializeToVault(
      {
        sandboxMdPath: '/sandbox/My note title.md',
        targetDir: '/Users/me/Notes',
      },
      deps,
    )
    const md = String(writtenFiles.get('/Users/me/Notes/My note title/My note title.md'))
    assert.match(md, /!\[hero\]\(<My note title\.assets\/[0-9a-f]+\.jpg>\)/, `got: ${md}`)
    assert.ok(!md.includes('My%20note%20title.assets'), 'asset folder name must not be percent-encoded')
  })

  it('saved .md image refs keep Chinese asset folder names readable and resolvable', async () => {
    const initialMd = '# Title\n\n![hero](https://cdn.example.com/hero.jpg)'
    const { deps, writtenFiles } = makeMemoryDeps({ initialMd })
    writtenFiles.set('/sandbox/二十年啦！陪MOLLY拾起沿途的风景.md', initialMd)

    await materializeToVault(
      {
        sandboxMdPath: '/sandbox/二十年啦！陪MOLLY拾起沿途的风景.md',
        targetDir: '/Users/me/Notes',
      },
      deps,
    )
    const md = String(writtenFiles.get('/Users/me/Notes/二十年啦！陪MOLLY拾起沿途的风景/二十年啦！陪MOLLY拾起沿途的风景.md'))
    assert.match(md, /!\[hero\]\(二十年啦！陪MOLLY拾起沿途的风景\.assets\/[0-9a-f]+\.jpg\)/, `got: ${md}`)
    assert.ok(!md.includes('%E4%BA%8C'), 'Chinese asset folder name must not be percent-encoded')
    assert.ok(!md.includes('<二十年啦'), 'Chinese-only path must not be angle-wrapped')
  })
})

describe('stripUnfetchableImageRefs · standalone', () => {
  it('strips blob: refs with auto-numbered alt entirely', () => {
    const input = '![Image 6](blob:http://localhost/abc)'
    assert.equal(stripUnfetchableImageRefs(input).trim(), '')
  })
  it('promotes meaningful alt to italic', () => {
    const input = '![A real caption](blob:http://localhost/abc)'
    assert.equal(stripUnfetchableImageRefs(input).trim(), '_A real caption_')
  })
  it('preserves http(s) refs', () => {
    const input = '![hero](https://e.com/h.jpg)'
    assert.equal(stripUnfetchableImageRefs(input), input)
  })
})

describe('inferExtension · MIME and URL fallbacks', () => {
  it('maps known MIME types', () => {
    assert.equal(inferExtension('https://x/y', 'image/jpeg'), '.jpg')
    assert.equal(inferExtension('https://x/y', 'image/png'), '.png')
    assert.equal(inferExtension('https://x/y', 'image/webp'), '.webp')
    assert.equal(inferExtension('https://x/y', 'image/svg+xml'), '.svg')
    assert.equal(inferExtension('https://x/y', 'image/avif'), '.avif')
  })

  it('strips charset / params from content-type', () => {
    assert.equal(inferExtension('https://x/y', 'image/jpeg; charset=utf-8'), '.jpg')
  })

  it('falls back to URL extension when content-type is missing', () => {
    assert.equal(inferExtension('https://cdn.example.com/foo.webp', ''), '.webp')
    assert.equal(inferExtension('https://cdn.example.com/foo.gif', ''), '.gif')
  })

  it('defaults to .jpg when nothing else is conclusive', () => {
    assert.equal(inferExtension('https://cdn.example.com/foo', ''), '.jpg')
    assert.equal(inferExtension('https://cdn.example.com/foo.unknown', 'application/octet-stream'), '.jpg')
  })
})
