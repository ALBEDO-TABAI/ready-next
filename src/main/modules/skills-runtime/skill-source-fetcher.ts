// Fetch a resolved skill tarball URL into a writable staging dir, then extract +
// locate the skill folder so the existing importCustomSkill scan/copy/register
// path can take over. Single responsibility: download → verify → extract → locate.
// The caller (runtime-manager) resolves the URL + 国内/国外 switch + ref→SHA pin
// first; this module is given a concrete URL and never re-decides the source.
//
// Safety fences kept here: an aggregate size cap (DOS), gzip-magic validation
// (reject .zip / non-gzip with a clear message), sha256 streamed for provenance,
// and staging strictly under the writable cacheRoot (never the read-only .app).

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { FetchLike } from './skill-source-registry'

const execFileAsync = promisify(execFile)

export const DEFAULT_SKILL_SIZE_CAP_BYTES = 50 * 1024 * 1024

export interface SkillFetchProgress {
  downloadedBytes: number
  totalBytes: number | null
  percent: number | null
}

export interface FetchSkillOptions {
  url: string
  requestId: string
  // Writable staging base (the manager's cacheRoot under userData).
  cacheRoot: string
  // Monorepo subdir inside the extracted archive (github /tree/<ref>/<subdir>).
  subdir?: string
  // How many leading path components to strip on extract. GitHub archives wrap
  // everything in a single `<repo>-<sha>/` dir (strip 1); a direct tarball is
  // taken as-is (strip 0) and the skill root is located after extraction.
  stripComponents?: number
  expectedSha256?: string | null
  sizeCapBytes?: number
  onProgress?: (progress: SkillFetchProgress) => void
  signal?: AbortSignal
  fetchImpl?: FetchLike
  // Test override; defaults to the platform bsdtar/tar.
  tarBinary?: string
}

export interface FetchSkillResult {
  // The per-request staging root the caller MUST clean up when finished.
  stagingRoot: string
  // The located skill folder (contains SKILL.md) to hand to importCustomSkill.
  skillDir: string
  sha256: string
  bytes: number
  license: string | null
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function resolveTarBinary(override?: string): string {
  if (override) return override
  if (process.platform === 'darwin') {
    for (const candidate of ['/usr/bin/bsdtar', '/usr/bin/tar']) {
      if (existsSync(candidate)) return candidate
    }
  }
  return 'tar'
}

// Reject anything that is not a real gzip stream up front with a precise message
// (a .zip's "PK\x03\x04" is the common confusion) before we hand it to tar.
function assertGzipMagic(buffer: Buffer): void {
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    throw new Error('暂不支持 .zip 压缩包，请提供 .tar.gz / .tgz 来源')
  }
  if (buffer.length < 2 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
    throw new Error('下载内容不是有效的 .tar.gz 压缩包')
  }
}

async function streamToBuffer(
  url: string,
  options: FetchSkillOptions,
  sizeCap: number,
): Promise<{ buffer: Buffer; sha256: string }> {
  const fetchImpl = options.fetchImpl ?? ((u: string, init?: RequestInit) => fetch(u, init))
  const res = await fetchImpl(url, { signal: options.signal })
  if (!res.ok) {
    throw new Error(`下载失败（HTTP ${res.status}）：${url}`)
  }
  const totalHeader = res.headers.get('content-length')
  const totalBytes = totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : null
  if (totalBytes !== null && totalBytes > sizeCap) {
    throw new Error(`技能包体积 ${(totalBytes / 1024 / 1024).toFixed(1)}MB 超过上限 ${(sizeCap / 1024 / 1024).toFixed(0)}MB`)
  }

  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let downloaded = 0

  const emit = (): void => {
    options.onProgress?.({
      downloadedBytes: downloaded,
      totalBytes,
      percent: totalBytes ? Math.min(100, Math.floor((downloaded / totalBytes) * 100)) : null,
    })
  }

  const body = res.body
  if (!body) {
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length > sizeCap) {
      throw new Error(`技能包体积超过上限 ${(sizeCap / 1024 / 1024).toFixed(0)}MB`)
    }
    hash.update(buffer)
    downloaded = buffer.length
    emit()
    return { buffer, sha256: hash.digest('hex') }
  }

  const reader = body.getReader()
  for (;;) {
    if (options.signal?.aborted) {
      await reader.cancel().catch(() => undefined)
      throw abortError('安装已取消')
    }
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const buf = Buffer.from(value)
    downloaded += buf.length
    if (downloaded > sizeCap) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`技能包体积超过上限 ${(sizeCap / 1024 / 1024).toFixed(0)}MB`)
    }
    hash.update(buf)
    chunks.push(buf)
    emit()
  }
  return { buffer: Buffer.concat(chunks), sha256: hash.digest('hex') }
}

// After extraction, find the folder that actually holds SKILL.md. With a subdir
// it is a fixed path; otherwise we accept the extract root, and if that root has
// no SKILL.md but a single child dir, we descend once (handles a tarball that
// wraps its skill in one directory and was extracted without stripping).
function locateSkillRoot(extractDir: string, subdir?: string): string {
  if (subdir) {
    const segments = subdir.split('/').map((s) => s.trim()).filter(Boolean)
    const target = join(extractDir, ...segments)
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      throw new Error(`压缩包中未找到子目录：${subdir}`)
    }
    return target
  }
  if (existsSync(join(extractDir, 'SKILL.md'))) return extractDir
  const entries = readdirSync(extractDir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'))
  const dirs = entries.filter((e) => e.isDirectory())
  if (!existsSync(join(extractDir, 'SKILL.md')) && entries.length === 1 && dirs.length === 1) {
    const descended = join(extractDir, dirs[0].name)
    if (existsSync(join(descended, 'SKILL.md'))) return descended
    return descended
  }
  return extractDir
}

// Surface a license hint for the confirm card: SKILL.md frontmatter `license:`
// first, else a token scanned from a LICENSE* file, else null.
function readLicenseHint(skillDir: string): string | null {
  try {
    const skillMd = join(skillDir, 'SKILL.md')
    if (existsSync(skillMd)) {
      const text = readFileSync(skillMd, 'utf-8')
      const frontmatter = text.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/)
      const body = frontmatter ? frontmatter[1] : ''
      const licenseLine = body.match(/^\s*license\s*:\s*(.+)\s*$/im)
      if (licenseLine) {
        const value = licenseLine[1].trim().replace(/^["']|["']$/g, '')
        if (value) return value
      }
    }
  } catch {
    // silent-catch: a malformed SKILL.md just means no frontmatter license hint;
    // we fall through to the LICENSE-file scan, and the field stays best-effort.
  }
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
    const licensePath = join(skillDir, name)
    if (!existsSync(licensePath)) continue
    try {
      const head = readFileSync(licensePath, 'utf-8').slice(0, 2048).toUpperCase()
      for (const token of ['AGPL', 'LGPL', 'GPL', 'APACHE', 'MIT', 'BSD', 'MPL', 'SSPL']) {
        if (head.includes(token)) return token === 'AGPL' || token === 'LGPL' ? `${token}` : token
      }
      return 'present-unknown'
    } catch {
      // silent-catch: an unreadable LICENSE file is not fatal — license stays a
      // best-effort hint and the install proceeds with what we know.
      return 'present-unknown'
    }
  }
  return null
}

// Download a resolved tarball URL into <cacheRoot>/skill-staging/<requestId>,
// verify it, extract it, and return the located skill folder + provenance.
export async function fetchSkillToStaging(options: FetchSkillOptions): Promise<FetchSkillResult> {
  const sizeCap = options.sizeCapBytes ?? DEFAULT_SKILL_SIZE_CAP_BYTES
  const stagingRoot = join(options.cacheRoot, 'skill-staging', options.requestId)
  const extractDir = join(stagingRoot, 'extract')
  const archivePath = join(stagingRoot, 'archive.tar.gz')

  if (options.signal?.aborted) throw abortError('安装已取消')
  mkdirSync(extractDir, { recursive: true })

  const { buffer, sha256 } = await streamToBuffer(options.url, options, sizeCap)
  assertGzipMagic(buffer)
  if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== sha256.toLowerCase()) {
    throw new Error(`校验失败：下载内容 sha256 与期望不一致`)
  }
  writeFileSync(archivePath, buffer)

  const tarBinary = resolveTarBinary(options.tarBinary)
  const stripComponents = options.stripComponents ?? 0
  await execFileAsync(
    tarBinary,
    ['-xzf', archivePath, '-C', extractDir, `--strip-components=${stripComponents}`],
    { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
  )

  const skillDir = locateSkillRoot(extractDir, options.subdir)
  const license = readLicenseHint(skillDir)
  return { stagingRoot, skillDir, sha256, bytes: buffer.length, license }
}
