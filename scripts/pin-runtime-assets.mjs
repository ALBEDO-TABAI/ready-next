#!/usr/bin/env node
// P0 (plan §0.6): download each runtime asset, compute the real sha256, and
// verify the internal layout, so the placeholder PENDING_P0_PIN digests in
// src/shared/runtime-asset-registry.ts can be replaced with real values.
//
// MUST run on a networked machine. It prints ready-to-paste `sha256:` values and
// writes build/runtime-asset-pins.json. It does NOT mutate the registry (so the
// developer reviews the diff before pinning). Mac can fetch the win64 archive
// too, so all three platforms' digests can be produced from one host.
//
// Usage: node scripts/pin-runtime-assets.mjs [--out build/runtime-asset-pins.json]

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))

// Keep these in sync with src/shared/runtime-asset-registry.ts.
const PBS_TAG = '20240814'
const PY_VER = '3.11.9'
const GHPROXY = 'https://ghproxy.net/'

const pyTriples = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

function pyAsset(platform) {
  const triple = pyTriples[platform]
  const filename = `cpython-${PY_VER}+${PBS_TAG}-${triple}-install_only.tar.gz`
  const gh = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${filename}`
  return {
    platform, id: 'python', filename, archiveKind: 'tar.gz',
    sources: [gh, `${GHPROXY}${gh}`],
    expectEntries: [platform === 'win32-x64' ? 'python/python.exe' : 'python/bin/python3'],
  }
}

const ffmpegAssets = [
  {
    platform: 'win32-x64', id: 'ffmpeg', filename: 'ffmpeg-master-latest-win64-gpl.zip', archiveKind: 'zip',
    sources: ['https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'],
    expectEntries: ['ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe', 'ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe'],
  },
  // mac ffmpeg: fill the real static-build URLs here before running (the registry
  //   placeholders point at ready-runtime.invalid on purpose).
  { platform: 'darwin-arm64', id: 'ffmpeg', filename: 'ffmpeg-ffprobe-darwin-arm64.zip', archiveKind: 'zip', sources: [], expectEntries: ['ffmpeg', 'ffprobe'] },
  { platform: 'darwin-x64', id: 'ffmpeg', filename: 'ffmpeg-ffprobe-darwin-x64.zip', archiveKind: 'zip', sources: [], expectEntries: ['ffmpeg', 'ffprobe'] },
]

const ASSETS = [
  pyAsset('darwin-arm64'), pyAsset('darwin-x64'), pyAsset('win32-x64'),
  ...ffmpegAssets,
]

async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function listEntries(buffer, archiveKind) {
  const tmp = join(tmpdir(), `pin-${process.pid}-${Date.now()}.${archiveKind === 'zip' ? 'zip' : 'tar.gz'}`)
  writeFileSync(tmp, buffer)
  try {
    return execFileSync('tar', ['-tf', tmp], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
  }
}

async function main() {
  const outArg = process.argv.indexOf('--out')
  const outPath = outArg >= 0 ? resolve(process.argv[outArg + 1]) : join(projectRoot, 'build', 'runtime-asset-pins.json')
  const pins = []
  for (const asset of ASSETS) {
    if (asset.sources.length === 0) {
      console.warn(`[pin] SKIP ${asset.platform}/${asset.id}: no source URL (fill it in this script first)`) // eslint-disable-line no-console
      continue
    }
    let buffer = null
    let lastErr = null
    for (const url of asset.sources) {
      try { buffer = await download(url); break } catch (error) { lastErr = error }
    }
    if (!buffer) {
      console.error(`[pin] FAIL ${asset.platform}/${asset.id}: ${lastErr?.message || 'unreachable'}`) // eslint-disable-line no-console
      process.exitCode = 1
      continue
    }
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const entries = listEntries(buffer, asset.archiveKind)
    const entrySet = new Set(entries)
    const missing = asset.expectEntries.filter((e) => !entrySet.has(e))
    const layoutOk = missing.length === 0
    pins.push({ platform: asset.platform, id: asset.id, filename: asset.filename, sha256, bytes: buffer.length, layoutOk, missing })
    console.log(`[pin] ${asset.platform}/${asset.id}  sha256=${sha256}  bytes=${buffer.length}  layout=${layoutOk ? 'OK' : `MISSING ${missing.join(',')}`}`) // eslint-disable-line no-console
  }
  mkdirSync(join(outPath, '..'), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(pins, null, 2)}\n`, 'utf8')
  console.log(`\n[pin] wrote ${outPath}`) // eslint-disable-line no-console
  console.log('[pin] paste each sha256 into src/shared/runtime-asset-registry.ts (replace PENDING_P0_PIN).') // eslint-disable-line no-console
}

main().catch((error) => { console.error(error); process.exit(1) }) // eslint-disable-line no-console
