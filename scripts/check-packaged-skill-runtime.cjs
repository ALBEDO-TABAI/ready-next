#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const options = {
    app: '',
    dmg: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--app') {
      options.app = next || ''
      index += 1
    } else if (arg === '--dmg') {
      options.dmg = next || ''
      index += 1
    }
  }
  return options
}

function defaultAppPath() {
  if (process.platform === 'darwin') {
    return path.join(ROOT, 'exports', 'mac-arm64', 'Ready.app')
  }
  if (process.platform === 'win32') {
    return path.join(ROOT, 'exports', 'win-unpacked')
  }
  return path.join(ROOT, 'exports', 'linux-unpacked')
}

function resourcesPathForApp(appPath) {
  if (process.platform === 'darwin' || appPath.endsWith('.app')) {
    return path.join(appPath, 'Contents', 'Resources')
  }
  return path.join(appPath, 'resources')
}

function exists(file) {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

function isDarwinAppBundle(appPath) {
  return appPath.endsWith('.app')
}

function verifyDarwinAppBundleStructure(appPath) {
  if (!isDarwinAppBundle(appPath)) return null
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Ready')
  const framework = path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'Current',
    'Electron Framework',
  )
  if (!exists(executable)) {
    throw new Error(`missing Ready executable at ${executable}`)
  }
  if (!exists(framework)) {
    throw new Error(`missing Electron Framework binary at ${framework}`)
  }
  return { executable, framework }
}

function verifyCodeSignature(appPath) {
  if (process.platform !== 'darwin' || !isDarwinAppBundle(appPath)) return null
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
      stdio: 'pipe',
      encoding: 'utf8',
    })
    return true
  } catch (error) {
    const details = [
      error.stdout ? String(error.stdout).trim() : '',
      error.stderr ? String(error.stderr).trim() : '',
      error.message || '',
    ].filter(Boolean).join('\n')
    throw new Error(`codesign verification failed for ${appPath}${details ? `\n${details}` : ''}`)
  }
}

function verifyNoExternalSymlinks(rootPath) {
  const rootRealPath = fs.realpathSync(rootPath)
  let symlinkCount = 0
  const stack = [rootPath]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        symlinkCount += 1
        let realPath
        try {
          realPath = fs.realpathSync(entryPath)
        } catch (error) {
          throw new Error(`broken symlink in packaged runtime: ${entryPath}`)
        }
        const relative = path.relative(rootRealPath, realPath)
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`external symlink in packaged runtime: ${entryPath} -> ${realPath}`)
        }
      } else if (entry.isDirectory()) {
        stack.push(entryPath)
      }
    }
  }
  return symlinkCount
}

function readManifest(runtimeRoot) {
  const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json')
  if (!exists(manifestPath)) {
    throw new Error(`missing runtime-manifest.json at ${manifestPath}`)
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

function requireAny(runtimeRoot, relCandidates, label) {
  const found = relCandidates
    .map((rel) => path.join(runtimeRoot, rel))
    .find((candidate) => exists(candidate))
  if (!found) {
    throw new Error(`missing ${label}; checked ${relCandidates.join(', ')}`)
  }
  return found
}

function verifyPackagedSkillRuntime(appPath) {
  const resources = resourcesPathForApp(appPath)
  const runtimeRoot = path.join(resources, 'skill-runtime')
  if (!exists(resources)) throw new Error(`packaged resources not found: ${resources}`)
  if (!exists(runtimeRoot)) throw new Error(`packaged skill-runtime not found: ${runtimeRoot}`)

  const manifest = readManifest(runtimeRoot)
  const skills = Array.isArray(manifest.embeddedSkillIds) ? manifest.embeddedSkillIds : []
  const tools = Array.isArray(manifest.tools) ? manifest.tools : []
  for (const skillId of ['video-expert-analyzer', 'video-copy-analyzer']) {
    if (!skills.includes(skillId)) {
      throw new Error(`packaged runtime manifest does not cover ${skillId}`)
    }
  }
  for (const tool of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
    if (!tools.includes(tool)) {
      throw new Error(`packaged runtime manifest does not declare ${tool}`)
    }
  }

  const python = process.platform === 'win32'
    ? requireAny(runtimeRoot, ['python/Scripts/python.exe'], 'packaged Python')
    : requireAny(runtimeRoot, ['python/bin/python3', 'python/bin/python'], 'packaged Python')
  const ytDlp = requireAny(runtimeRoot, [
    'bin/yt-dlp',
    'bin/yt-dlp.exe',
    'python/bin/yt-dlp',
    'python/Scripts/yt-dlp.exe',
  ], 'yt-dlp')
  const ffmpeg = requireAny(runtimeRoot, ['bin/ffmpeg', 'bin/ffmpeg.exe'], 'ffmpeg')
  const ffprobe = requireAny(runtimeRoot, ['bin/ffprobe', 'bin/ffprobe.exe'], 'ffprobe')
  const symlinkCount = verifyNoExternalSymlinks(runtimeRoot)

  return {
    appPath,
    runtimeRoot,
    runtimeId: manifest.runtimeId || null,
    python,
    ytDlp,
    ffmpeg,
    ffprobe,
    symlinkCount,
  }
}

function verifyPackagedApp(appPath, options = {}) {
  const bundle = verifyDarwinAppBundleStructure(appPath)
  const runtime = verifyPackagedSkillRuntime(appPath)
  const signature = options.verifySignature === false ? null : verifyCodeSignature(appPath)
  return { appPath, bundle, runtime, signature }
}

function findMountedApp(mountPath) {
  const entries = fs.readdirSync(mountPath, { withFileTypes: true })
  const app = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  if (!app) {
    throw new Error(`mounted DMG does not contain a .app at ${mountPath}`)
  }
  return path.join(mountPath, app.name)
}

function verifyDmg(dmgPath) {
  if (process.platform !== 'darwin') {
    throw new Error('--dmg verification is only supported on macOS')
  }
  const resolvedDmg = path.resolve(dmgPath)
  if (!exists(resolvedDmg)) {
    throw new Error(`DMG not found: ${resolvedDmg}`)
  }
  const mountPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-packaged-runtime-dmg-'))
  try {
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPath, resolvedDmg], {
      stdio: 'pipe',
      encoding: 'utf8',
    })
    const appPath = findMountedApp(mountPath)
    if (!exists(path.join(mountPath, 'Applications'))) {
      throw new Error(`mounted DMG is missing Applications link at ${mountPath}`)
    }
    const result = verifyPackagedApp(appPath)
    return { dmgPath: resolvedDmg, mountPath, appPath, result }
  } finally {
    try {
      execFileSync('hdiutil', ['detach', mountPath], { stdio: 'pipe' })
    } catch {
      // hdiutil may already have detached after a failed attach.
    }
    fs.rmSync(mountPath, { recursive: true, force: true })
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  try {
    if (options.dmg) {
      const result = verifyDmg(options.dmg)
      console.log(`[packaged-runtime] ok ${result.dmgPath}`)
      return 0
    }
    const appPath = path.resolve(options.app || defaultAppPath())
    const result = verifyPackagedApp(appPath)
    console.log(`[packaged-runtime] ok ${result.runtime.runtimeRoot}`)
    return 0
  } catch (error) {
    console.error(`[packaged-runtime] ${error instanceof Error ? error.message : String(error)}`)
    console.error('[packaged-runtime] Use READY_RELEASE_SKILL_RUNTIME_ROOT=/path/to/skill-runtime npm run build:dist:seeded for release DMGs.')
    return 1
  }
}

if (require.main === module) {
  process.exit(main())
}

module.exports = {
  defaultAppPath,
  resourcesPathForApp,
  verifyDarwinAppBundleStructure,
  verifyDmg,
  verifyPackagedApp,
  verifyPackagedSkillRuntime,
}
