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
    run('tar', ['-xzf', archivePath, '-C', tempDir])
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
    const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe')
    const msbuild = run(vswhere, [
      '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-find', 'MSBuild/Current/Bin/MSBuild.exe',
    ])
    assert(msbuild, 'Visual Studio C++ build tools are required for the Windows Codex job')
    run(msbuild, [
      path.join(__dirname, 'windows-job/ready-codex-job.vcxproj'),
      '/nologo', '/verbosity:minimal', '/p:Configuration=Release', '/p:Platform=x64',
      '/p:OutDir=' + destinationDir + '/', '/p:IntDir=' + destinationDir + '/obj/',
    ])
    fs.writeFileSync(path.join(destinationDir, '../ready-codex-job.sha256'),
      digestFile(path.join(destinationDir, 'ready-codex-job.exe')) + '\n')
    const destination = path.join(destinationDir, 'codex.exe')
    // Replace atomically: a running sidecar keeps its own inode, and a half-copied binary is never visible.
    const staged = path.join(destinationDir, `.codex-${process.pid}-${Date.now()}`)
    try {
      fs.copyFileSync(extractedPath, staged)
      fs.chmodSync(staged, 0o755)
      assert(digestFile(staged) === sourceLock.releaseAsset.binarySha256, 'Copied binary digest mismatch')
      fs.renameSync(staged, destination)
    } finally {
      fs.rmSync(staged, { force: true })
    }
    assert(digestFile(destination) === sourceLock.releaseAsset.binarySha256, 'Installed binary digest mismatch')
    console.log(destination)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main()
