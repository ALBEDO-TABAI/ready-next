import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { fetchSkillToStaging, type FetchLike } from '../main/modules/skills-runtime/skill-source-fetcher'

const execFileAsync = promisify(execFile)

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const SKILL_MD = ['---', 'name: My Skill', 'license: MIT', '---', '# My Skill', 'advisory content'].join('\n')

// Build a real .tar.gz buffer by writing files then invoking the system tar, so
// the fetcher's extraction path is exercised for real (not mocked).
async function makeTarGz(layout: Record<string, string>, topEntry: string): Promise<Buffer> {
  const work = scratch('ready-tar-src-')
  try {
    for (const [relPath, content] of Object.entries(layout)) {
      const full = join(work, relPath)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    const out = join(scratch('ready-tar-out-'), 'archive.tar.gz')
    await execFileAsync('tar', ['-czf', out, '-C', work, topEntry])
    return readFileSync(out)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function serve(buffer: Buffer): FetchLike {
  return async () => new Response(buffer, { headers: { 'content-length': String(buffer.length) } })
}

test('fetchSkillToStaging extracts a github-style wrapped archive with strip-components=1', async () => {
  const cacheRoot = scratch('ready-cache-')
  try {
    const buffer = await makeTarGz({ 'pkg-deadbeef/SKILL.md': SKILL_MD }, 'pkg-deadbeef')
    const seenProgress: number[] = []
    const result = await fetchSkillToStaging({
      url: 'https://codeload.github.com/op7418/pkg/tar.gz/deadbeef',
      requestId: 'req-1',
      cacheRoot,
      stripComponents: 1,
      fetchImpl: serve(buffer),
      onProgress: (p) => seenProgress.push(p.downloadedBytes),
    })
    assert.ok(existsSync(join(result.skillDir, 'SKILL.md')), 'SKILL.md should be at the located root')
    assert.equal(readFileSync(join(result.skillDir, 'SKILL.md'), 'utf-8'), SKILL_MD)
    assert.equal(result.license, 'MIT')
    assert.match(result.sha256, /^[0-9a-f]{64}$/)
    assert.ok(result.bytes > 0)
    assert.ok(seenProgress.length > 0, 'progress should be reported')
    assert.ok(result.stagingRoot.includes('skill-staging'))
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('fetchSkillToStaging locates a monorepo subdir inside the archive', async () => {
  const cacheRoot = scratch('ready-cache-')
  try {
    const buffer = await makeTarGz(
      { 'repo-sha/skills/mine/SKILL.md': SKILL_MD, 'repo-sha/README.md': '# top' },
      'repo-sha',
    )
    const result = await fetchSkillToStaging({
      url: 'https://codeload.github.com/acme/repo/tar.gz/sha',
      requestId: 'req-sub',
      cacheRoot,
      stripComponents: 1,
      subdir: 'skills/mine',
      fetchImpl: serve(buffer),
    })
    assert.ok(existsSync(join(result.skillDir, 'SKILL.md')))
    assert.ok(result.skillDir.endsWith(join('skills', 'mine')))
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('fetchSkillToStaging descends into a single wrapper dir for a direct tarball (strip 0)', async () => {
  const cacheRoot = scratch('ready-cache-')
  try {
    const buffer = await makeTarGz({ 'mypack/SKILL.md': SKILL_MD }, 'mypack')
    const result = await fetchSkillToStaging({
      url: 'https://example.com/mypack.tar.gz',
      requestId: 'req-direct',
      cacheRoot,
      stripComponents: 0,
      fetchImpl: serve(buffer),
    })
    assert.ok(existsSync(join(result.skillDir, 'SKILL.md')))
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('fetchSkillToStaging rejects a .zip payload with a clear message', async () => {
  const cacheRoot = scratch('ready-cache-')
  try {
    const zipish = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])
    await assert.rejects(
      () =>
        fetchSkillToStaging({
          url: 'https://example.com/pack.tar.gz',
          requestId: 'req-zip',
          cacheRoot,
          fetchImpl: serve(zipish),
        }),
      /不支持 \.zip/,
    )
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('fetchSkillToStaging rejects an archive whose member escapes the staging dir', async () => {
  const cacheRoot = scratch('ready-cache-')
  const srcDir = scratch('ready-evil-src-')
  try {
    const abs = join(srcDir, 'escape.txt')
    writeFileSync(abs, 'pwned')
    const out = join(scratch('ready-evil-out-'), 'evil.tar.gz')
    // -P preserves the absolute path as the stored member (bsdtar + GNU tar), so
    // the tarball carries a path that would escape the extraction dir.
    await execFileAsync('tar', ['-czPf', out, abs])
    await assert.rejects(
      () =>
        fetchSkillToStaging({
          url: 'https://example.com/evil.tar.gz',
          requestId: 'req-evil',
          cacheRoot,
          fetchImpl: serve(readFileSync(out)),
        }),
      /绝对路径|越界/,
    )
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
    rmSync(srcDir, { recursive: true, force: true })
  }
})

test('fetchSkillToStaging enforces the aggregate size cap', async () => {
  const cacheRoot = scratch('ready-cache-')
  try {
    const buffer = await makeTarGz({ 'pkg/SKILL.md': SKILL_MD }, 'pkg')
    await assert.rejects(
      () =>
        fetchSkillToStaging({
          url: 'https://example.com/pack.tar.gz',
          requestId: 'req-big',
          cacheRoot,
          sizeCapBytes: 4,
          fetchImpl: serve(buffer),
        }),
      /超过上限/,
    )
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('fetchSkillToStaging fails a sha256 mismatch', async () => {
  const cacheRoot = scratch('ready-cache-')
  try {
    const buffer = await makeTarGz({ 'pkg/SKILL.md': SKILL_MD }, 'pkg')
    await assert.rejects(
      () =>
        fetchSkillToStaging({
          url: 'https://example.com/pack.tar.gz',
          requestId: 'req-sha',
          cacheRoot,
          stripComponents: 1,
          expectedSha256: 'deadbeef',
          fetchImpl: serve(buffer),
        }),
      /校验失败/,
    )
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('fetchSkillToStaging throws AbortError when the signal is already aborted', async () => {
  const cacheRoot = scratch('ready-cache-')
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () =>
        fetchSkillToStaging({
          url: 'https://example.com/pack.tar.gz',
          requestId: 'req-abort',
          cacheRoot,
          signal: controller.signal,
          fetchImpl: serve(Buffer.from([0x1f, 0x8b])),
        }),
      (err: Error) => err.name === 'AbortError',
    )
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})
