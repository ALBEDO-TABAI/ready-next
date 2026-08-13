#!/usr/bin/env node
// Download each runtime asset, recompute sha256, and verify the internal layout
// before changing a pinned coordinate in src/shared/runtime-asset-registry.ts.
//
// MUST run on a networked machine. It prints ready-to-paste `sha256:` values and
// writes build/runtime-asset-pins.json. It does NOT mutate the registry (so the
// developer reviews the diff before pinning). Mac can fetch the win64 archive
// too, so all three platforms' digests can be produced from one host.
//
// Usage: node scripts/pin-runtime-assets.mjs [--out build/runtime-asset-pins.json]
// Test-only: node scripts/pin-runtime-assets.mjs --manifest /tmp/assets.json --out /tmp/pins.json

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))

// Keep these in sync with src/shared/runtime-asset-registry.ts.
const PBS_RELEASE_TAG = '20260610'
const PBS_BUILD_TAG = '20260610'
const PY_VER = '3.11.15'
const GHPROXY = 'https://ghproxy.net/'
const USTC_GITHUB_RELEASE = 'https://mirrors.ustc.edu.cn/github-release'

const pyTriples = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

function pyAsset(platform) {
  const triple = pyTriples[platform]
  const filename = `cpython-${PY_VER}+${PBS_BUILD_TAG}-${triple}-install_only.tar.gz`
  const ustc = `${USTC_GITHUB_RELEASE}/astral-sh/python-build-standalone/${PBS_RELEASE_TAG}/${filename}`
  const gh = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE_TAG}/${filename}`
  return {
    platform, id: 'python',
    archives: [{
      filename, archiveKind: 'tar.gz',
      sources: [ustc, gh, `${GHPROXY}${gh}`],
      outputs: [{ kind: 'python', relPath: platform === 'win32-x64' ? 'python/python.exe' : 'python/bin/python3' }],
    }],
  }
}

const ffmpegAssets = [
  {
    platform: 'win32-x64', id: 'ffmpeg',
    archives: [{
      filename: 'ffmpeg-master-latest-win64-gpl.zip', archiveKind: 'zip',
      sources: ['https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'],
      outputs: [
        { kind: 'ffmpeg', relPath: 'ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe' },
        { kind: 'ffprobe', relPath: 'ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe' },
      ],
    }],
  },
  {
    platform: 'darwin-arm64', id: 'ffmpeg',
    archives: [
      {
        filename: 'ffmpeg81arm.zip', archiveKind: 'zip',
        sources: ['https://www.osxexperts.net/ffmpeg81arm.zip'],
        outputs: [{ kind: 'ffmpeg', relPath: 'ffmpeg', expectedSha256: '9a08d61f9328e8164ba560ee7a79958e357307fcfeea6fe626b7d66cdc287028' }],
      },
      {
        filename: 'ffprobe81arm.zip', archiveKind: 'zip',
        sources: ['https://www.osxexperts.net/ffprobe81arm.zip'],
        outputs: [{ kind: 'ffprobe', relPath: 'ffprobe', expectedSha256: 'aab17ac7379c1178aaf400c3ef36cdb67db0b75b1a23eeef2cb9f658be8844e6' }],
      },
    ],
  },
  {
    platform: 'darwin-x64', id: 'ffmpeg',
    archives: [
      {
        filename: 'ffmpeg80intel.zip', archiveKind: 'zip',
        sources: ['https://www.osxexperts.net/ffmpeg80intel.zip'],
        outputs: [{ kind: 'ffmpeg', relPath: 'ffmpeg', expectedSha256: 'df3f1e3facdc1ae0ad0bd898cdfb072fbc9641bf47b11f172844525a05db8d11' }],
      },
      {
        filename: 'ffprobe80intel.zip', archiveKind: 'zip',
        sources: ['https://www.osxexperts.net/ffprobe80intel.zip'],
        outputs: [{ kind: 'ffprobe', relPath: 'ffprobe', expectedSha256: '5228e651e2bd67bb55819b27f6138351587b16d2b87446007bf35b7cf930d891' }],
      },
    ],
  },
]

const ASSETS = [
  pyAsset('darwin-arm64'), pyAsset('darwin-x64'), pyAsset('win32-x64'),
  ...ffmpegAssets,
]

async function download(url) {
  if (url.startsWith('file:')) return readFileSync(fileURLToPath(url))
  // Retry transient interrupts (large files from osxexperts/BtbN sometimes
  //   "terminated" mid-stream); a 4xx/5xx HTTP code is not retried.
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (error) {
      lastErr = error
      if (/HTTP [45]\d\d/.test(String(error?.message))) break
    }
  }
  throw lastErr
}

function assertSafeEntry(entry) {
  const normalized = entry.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').some((seg) => seg === '..')) {
    throw new Error(`unsafe archive entry: ${entry}`)
  }
}

function inspectArchive(buffer, archive) {
  const work = mkdtempSync(join(tmpdir(), `ready-pin-${process.pid}-`))
  const tmp = join(work, `asset.${archive.archiveKind === 'zip' ? 'zip' : 'tar.gz'}`)
  const extractDir = join(work, 'extract')
  writeFileSync(tmp, buffer)
  try {
    const entries = execFileSync('tar', ['-tf', tmp], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean)
    for (const entry of entries) assertSafeEntry(entry)
    mkdirSync(extractDir, { recursive: true })
    execFileSync('tar', ['-xf', tmp, '-C', extractDir], { maxBuffer: 64 * 1024 * 1024 })
    const entrySet = new Set(entries)
    const outputChecks = []
    for (const output of archive.outputs) {
      const missing = !entrySet.has(output.relPath)
      let actualSha256 = null
      let shaOk = null
      if (!missing && output.expectedSha256) {
        const outputPath = join(extractDir, output.relPath)
        if (lstatSync(outputPath).isSymbolicLink()) throw new Error(`unsafe output symlink: ${output.relPath}`)
        actualSha256 = createHash('sha256').update(readFileSync(outputPath)).digest('hex')
        shaOk = actualSha256 === output.expectedSha256
      }
      outputChecks.push({ ...output, missing, actualSha256, shaOk })
    }
    return { entries, outputChecks }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

async function main() {
  const outArg = process.argv.indexOf('--out')
  const outPath = outArg >= 0 ? resolve(process.argv[outArg + 1]) : join(projectRoot, 'build', 'runtime-asset-pins.json')
  const manifestArg = process.argv.indexOf('--manifest')
  const assets = manifestArg >= 0 ? JSON.parse(readFileSync(resolve(process.argv[manifestArg + 1]), 'utf8')) : ASSETS
  const pins = []
  for (const asset of assets) {
    for (const archive of asset.archives) {
      let buffer = null
      let lastErr = null
      for (const url of archive.sources) {
        try { buffer = await download(url); break } catch (error) { lastErr = error }
      }
      if (!buffer) {
        console.error(`[pin] FAIL ${asset.platform}/${asset.id}/${archive.filename}: ${lastErr?.message || 'unreachable'}`)
        process.exitCode = 1
        continue
      }
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      let inspection
      try {
        inspection = inspectArchive(buffer, archive)
      } catch (error) {
        console.error(`[pin] FAIL ${asset.platform}/${asset.id}/${archive.filename}: ${error?.message || error}`)
        process.exitCode = 1
        continue
      }
      const missing = inspection.outputChecks.filter((o) => o.missing).map((o) => o.relPath)
      const badSha = inspection.outputChecks.filter((o) => o.shaOk === false).map((o) => o.relPath)
      const layoutOk = missing.length === 0 && badSha.length === 0
      pins.push({
        platform: asset.platform,
        id: asset.id,
        filename: archive.filename,
        sha256,
        bytes: buffer.length,
        layoutOk,
        missing,
        badSha,
        outputs: inspection.outputChecks,
      })
      const layout = layoutOk ? 'OK' : `MISSING ${missing.join(',')} BAD_SHA ${badSha.join(',')}`
      console.log(`[pin] ${asset.platform}/${asset.id}/${archive.filename}  sha256=${sha256}  bytes=${buffer.length}  layout=${layout}`)
    }
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(pins, null, 2)}\n`, 'utf8')
  console.log(`\n[pin] wrote ${outPath}`)
  console.log('[pin] compare these digests with src/shared/runtime-asset-registry.ts and update only reviewed changes.')
}

main().catch((error) => { console.error(error); process.exit(1) })
