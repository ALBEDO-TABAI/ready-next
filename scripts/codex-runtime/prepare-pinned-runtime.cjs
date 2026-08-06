const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  assert,
  assetRoot,
  digestFile,
  readJson,
  repoRoot
} = require('./contract-lib.cjs')

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${String(result.stderr || result.stdout).trim()}`)
  }
  return String(result.stdout || '').trim()
}

function main() {
  const archiveArg = argumentValue('--archive')
  assert(archiveArg, 'Usage: node scripts/codex-runtime/prepare-pinned-runtime.cjs --archive <official tar.gz>')
  const archivePath = path.resolve(archiveArg)
  assert(fs.statSync(archivePath).isFile(), `Archive is not a file: ${archivePath}`)

  const sourceLock = readJson(path.join(assetRoot, 'source-lock.json'))
  assert(
    digestFile(archivePath) === sourceLock.releaseAsset.archiveSha256,
    'Official archive SHA-256 mismatch'
  )

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-codex-runtime-'))
  try {
    run('/usr/bin/tar', ['-xzf', archivePath, '-C', tempDir])
    const extractedPath = path.join(tempDir, sourceLock.releaseAsset.binaryNameInArchive)
    assert(fs.existsSync(extractedPath), 'Pinned binary is missing from the archive')
    assert(
      digestFile(extractedPath) === sourceLock.releaseAsset.binarySha256,
      'Extracted binary SHA-256 mismatch'
    )
    assert(
      fs.statSync(extractedPath).size === sourceLock.releaseAsset.binarySizeBytes,
      'Extracted binary size mismatch'
    )

    const version = run(extractedPath, ['--version'])
    assert(version === `codex-cli ${sourceLock.codexVersion}`, `Unexpected version: ${version}`)

    const destinationDir = path.join(
      repoRoot,
      'build/codex',
      `${sourceLock.targetTriple}`
    )
    fs.mkdirSync(destinationDir, { recursive: true })
    const destination = path.join(destinationDir, 'codex')
    fs.copyFileSync(extractedPath, destination)
    fs.chmodSync(destination, 0o755)
    assert(digestFile(destination) === sourceLock.releaseAsset.binarySha256, 'Copied binary digest mismatch')
    console.log(destination)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main()
