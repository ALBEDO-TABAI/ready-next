// Real IO implementations for RuntimeProvisioner (download / extract / probe /
// place). Network + binary execution can't be unit-tested in CI — these are
// exercised by P3 real-machine verification (plan §7/§8). Kept thin and
// correct-by-construction; the orchestration logic + classification live in
// runtime-provisioner.ts and are unit-tested.

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { assertSafeRuntimeArchiveEntry, markRuntimeIntegrityError } from '../../../shared/runtime-asset-registry'

const execFileAsync = promisify(execFile)

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Download with size cap + progress. Throws on connection/HTTP failure (→ unreachable). */
export async function downloadRuntimeArchive(
  url: string,
  onProgress: (received: number, total: number | null) => void,
  signal: AbortSignal,
  sizeCap: number,
): Promise<Buffer> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const totalHeader = res.headers.get('content-length')
  const total = totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : null
  if (total !== null && total > sizeCap) throw markRuntimeIntegrityError(new Error(`资产体积 ${total} 超过上限 ${sizeCap}`))
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > sizeCap) throw markRuntimeIntegrityError(new Error(`资产体积超过上限 ${sizeCap}`))
    onProgress(buf.length, total)
    return buf
  }
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      received += value.byteLength
      if (received > sizeCap) throw markRuntimeIntegrityError(new Error(`资产体积超过上限 ${sizeCap}`))
      chunks.push(Buffer.from(value))
      onProgress(received, total)
    }
  }
  return Buffer.concat(chunks)
}

// Parse `tar -tvf` lines ONLY for symlink targets (type char 'l'). The metadata
//   prefix makes path-from-verbose unreliable, so abs/`..` path checks use the
//   clean `tar -tf` names instead (see extractRuntimeArchive).
//   bsdtar/GNU: "lrwxr-xr-x 0 u g 0 <date> python/bin/python3 -> python3.11"
function parseSymlinkTargets(verboseListing: string): Array<{ linkPath: string; linkTarget: string }> {
  const out: Array<{ linkPath: string; linkTarget: string }> = []
  for (const raw of verboseListing.split('\n')) {
    const line = raw.trimEnd()
    if (!/^l/.test(line)) continue
    const arrow = line.indexOf(' -> ')
    if (arrow < 0) continue
    const target = line.slice(arrow + 4).trim()
    out.push({ linkPath: line.slice(0, arrow).trim(), linkTarget: target })
  }
  return out
}

/**
 * Extract a .tar.gz/.zip buffer to destDir using system `tar` (bsdtar handles
 * both on macOS/Win10+/Linux), guarding every entry (abs/`..`/escaping symlink)
 * BEFORE writing. Throws on any violation (→ integrity).
 *
 * abs/`..` are checked against the CLEAN `tar -tf` names (no metadata prefix);
 * symlink targets against the `l`-typed `tar -tvf` lines.
 */
export async function extractRuntimeArchive(params: {
  buffer: Buffer
  archiveKind: 'tar.gz' | 'zip'
  destDir: string
  sizeCap: number
}): Promise<void> {
  const tmp = join(tmpdir(), `ready-runtime-${process.pid}-${Date.now()}.${params.archiveKind === 'zip' ? 'zip' : 'tar.gz'}`)
  writeFileSync(tmp, params.buffer)
  try {
    // 1) Clean names → abs/`..` guard for EVERY entry.
    const names = (await execFileAsync('tar', ['-tf', tmp], { maxBuffer: 128 * 1024 * 1024 })).stdout
      .split('\n').map((s) => s.trim()).filter(Boolean)
    if (names.length === 0) throw new Error('空压缩包或无法列出条目（tar 不可用？）')
    for (const name of names) assertSafeRuntimeArchiveEntry(name)
    // 2) Symlink targets → escape guard.
    const verbose = (await execFileAsync('tar', ['-tvf', tmp], { maxBuffer: 128 * 1024 * 1024 })).stdout
    for (const link of parseSymlinkTargets(verbose)) {
      assertSafeRuntimeArchiveEntry(link.linkPath || 'symlink', { isSymlink: true, linkTarget: link.linkTarget })
    }
    mkdirSync(params.destDir, { recursive: true })
    await execFileAsync('tar', ['-xf', tmp, '-C', params.destDir], { maxBuffer: 128 * 1024 * 1024 })
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* silent-catch: temp cleanup best-effort */ }
  }
}

/** Atomic place of an extracted binary: temp sibling → rename; chmod 0755; mac de-quarantine. */
export function placeRuntimeExecutable(srcPath: string, destPath: string): void {
  mkdirSync(join(destPath, '..'), { recursive: true })
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`
  copyFileSync(srcPath, tmp)
  chmodSync(tmp, 0o755)
  renameSync(tmp, destPath)
  // De-quarantine AFTER rename, synchronously, on the final path (running it on
  //   the pre-rename temp would target a path that no longer exists).
  if (process.platform === 'darwin') {
    try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', destPath], { stdio: 'ignore' }) } catch { /* silent-catch: attr/xattr may be absent — best-effort */ }
    try { execFileSync('codesign', ['-s', '-', destPath], { stdio: 'ignore' }) } catch { /* silent-catch: unsigned static binaries may still run — probe decides */ }
  }
}

/** Probe an on-disk binary; returns ok:false (never throws) when missing/unrunnable/wrong-arch. */
export async function probeRuntimeBinary(
  path: string,
  kind: 'python' | 'ffmpeg' | 'ffprobe',
  env: NodeJS.ProcessEnv,
  expectedArch?: 'arm64' | 'x64',
): Promise<{ ok: boolean; version?: string; sslOk?: boolean; archOk?: boolean; detail?: string }> {
  if (!existsSync(path)) return { ok: false, detail: 'missing' }
  try {
    if (kind === 'python') {
      const ver = await execFileAsync(path, ['--version'], { env, timeout: 15_000 })
      const ssl = await execFileAsync(path, ['-c', 'import ssl; print(ssl.OPENSSL_VERSION)'], { env, timeout: 15_000 })
      return { ok: true, version: `${ver.stdout || ver.stderr}`.trim(), sslOk: /OpenSSL/i.test(ssl.stdout) }
    }
    const ver = await execFileAsync(path, ['-version'], { env, timeout: 15_000 })
    let archOk: boolean | undefined
    if (expectedArch && process.platform === 'darwin') {
      try {
        const f = await execFileAsync('file', [path], { timeout: 10_000 })
        const wantsArm = expectedArch === 'arm64'
        archOk = wantsArm ? /arm64/.test(f.stdout) : /x86_64/.test(f.stdout)
      } catch { /* silent-catch: arch probe is best-effort — unknown leaves archOk undefined */ archOk = undefined }
    }
    return { ok: true, version: `${ver.stdout}`.split('\n')[0]?.trim(), archOk }
  } catch (error) {
    // silent-catch: probe failure returns the structured {ok:false, detail} result
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

export function realpathOrNull(path: string): string | null {
  try { return realpathSync(path) } catch { return null }
}

export function readTextOrNull(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}
