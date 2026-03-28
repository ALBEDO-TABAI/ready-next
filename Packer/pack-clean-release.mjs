#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { basename, join, relative, resolve, sep } from 'node:path'
import YAML from 'yaml'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const packerRoot = fileURLToPath(new URL('./', import.meta.url))
const stagingRoot = join(packerRoot, '.staging', 'clean-package')
const exportsDir = join(projectRoot, 'exports')
const cleanSeedPath = join(stagingRoot, 'build', 'runtime-seeds', 'ai-settings.seed.json')
const cleanPythonRoot = join(stagingRoot, 'src', 'python')
const cleanEmbeddedSkillsRoot = join(stagingRoot, 'assets', 'embedded-skills')
const builderConfigPath = join(projectRoot, 'electron-builder.yml')
const tempBuilderConfigPath = join(stagingRoot, 'electron-builder.clean.yml')
const manifestPath = join(exportsDir, 'clean-package-manifest.json')

const argv = new Set(process.argv.slice(2))
const dirOnly = argv.has('--dir-only')
const skipCleanExports = argv.has('--skip-clean-exports')
const keepStaging = argv.has('--keep-staging')

const CLEAN_EXPORT_FILENAMES = new Set([
  'builder-debug.yml',
  'builder-effective-config.yaml',
  'latest-mac.yml',
  'clean-package-manifest.json',
])

const SKIP_DIR_NAMES = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
])

const SKIP_FILE_SUFFIXES = ['.pyc', '.pyo']
const SKIP_FILE_NAMES = new Set(['.DS_Store'])

const FORBIDDEN_RESOURCE_SEGMENTS = [
  'ready.db',
  'agent-memory',
  'agent-sidecar-runtime',
  'channel-attachments',
  'skill-runtime',
  'rss-artifacts',
  'rsshub-runtime',
  'puppeteer-cache',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
]

function logStep(title, detail) {
  process.stdout.write(`\n[packer] ${title}${detail ? `: ${detail}` : ''}\n`)
}

function toPosixRelative(targetPath) {
  return relative(projectRoot, targetPath).split(sep).join('/')
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function cleanDir(path) {
  rmSync(path, { recursive: true, force: true })
}

function copyFilteredTree(src, dst) {
  const stat = lstatSync(src)
  const name = basename(src)
  if (stat.isDirectory()) {
    if (SKIP_DIR_NAMES.has(name)) return
    ensureDir(dst)
    for (const child of readdirSync(src)) {
      copyFilteredTree(join(src, child), join(dst, child))
    }
    return
  }

  if (SKIP_FILE_NAMES.has(name)) return
  if (SKIP_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return

  ensureDir(resolve(dst, '..'))
  writeFileSync(dst, readFileSync(src))
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      DISABLE_AUTO_UPDATE: 'true',
    },
    ...options,
  })
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

function removeOldExports() {
  if (!existsSync(exportsDir)) return
  for (const name of readdirSync(exportsDir)) {
    const fullPath = join(exportsDir, name)
    if (CLEAN_EXPORT_FILENAMES.has(name)) {
      rmSync(fullPath, { recursive: true, force: true })
      continue
    }
    if (name === 'mac-arm64') {
      rmSync(fullPath, { recursive: true, force: true })
      continue
    }
    if (/^Ready-.*\.(dmg|blockmap)$/u.test(name)) {
      rmSync(fullPath, { recursive: true, force: true })
    }
  }
}

function removeGeneratedDebugFiles() {
  for (const name of CLEAN_EXPORT_FILENAMES) {
    rmSync(join(exportsDir, name), { recursive: true, force: true })
  }
}

function buildCleanBuilderConfig() {
  const parsed = YAML.parse(readFileSync(builderConfigPath, 'utf8'))
  const extraResources = Array.isArray(parsed.extraResources) ? parsed.extraResources : []

  parsed.directories = {
    ...(parsed.directories || {}),
    output: 'exports',
  }

  parsed.extraResources = extraResources.map((entry) => {
    if (entry?.from === 'build/runtime-seeds/ai-settings.seed.json') {
      return {
        ...entry,
        from: toPosixRelative(cleanSeedPath),
      }
    }
    if (entry?.from === 'src/python') {
      return {
        ...entry,
        from: toPosixRelative(cleanPythonRoot),
      }
    }
    if (entry?.from === 'assets/embedded-skills') {
      return {
        ...entry,
        from: toPosixRelative(cleanEmbeddedSkillsRoot),
      }
    }
    return entry
  })

  writeFileSync(tempBuilderConfigPath, YAML.stringify(parsed), 'utf8')
}

function createCleanSeed() {
  ensureDir(resolve(cleanSeedPath, '..'))
  writeFileSync(cleanSeedPath, '{}\n', 'utf8')
}

function prepareSanitizedPython() {
  const sourcePythonRoot = join(projectRoot, 'src', 'python')
  copyFilteredTree(sourcePythonRoot, cleanPythonRoot)
}

function prepareSanitizedEmbeddedSkills() {
  const sourceEmbeddedSkillsRoot = join(projectRoot, 'assets', 'embedded-skills')
  copyFilteredTree(sourceEmbeddedSkillsRoot, cleanEmbeddedSkillsRoot)
}

function collectFiles(rootDir) {
  const results = []
  if (!existsSync(rootDir)) return results

  const visit = (currentPath) => {
    const stat = lstatSync(currentPath)
    if (stat.isDirectory()) {
      for (const child of readdirSync(currentPath)) {
        visit(join(currentPath, child))
      }
      return
    }
    results.push(currentPath)
  }

  visit(rootDir)
  return results
}

function hasSensitiveAIConfig(seed) {
  const queue = [seed]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    for (const [key, value] of Object.entries(current)) {
      if (key === 'apiKey' && typeof value === 'string' && value.trim()) {
        return true
      }
      if (value && typeof value === 'object') queue.push(value)
    }
  }
  return false
}

function verifyPackagedResources() {
  const resourcesDir = join(exportsDir, 'mac-arm64', 'Ready.app', 'Contents', 'Resources')
  if (!existsSync(resourcesDir)) {
    throw new Error(`Packaged resources not found: ${resourcesDir}`)
  }

  const seedRaw = readFileSync(join(resourcesDir, 'ai-settings.seed.json'), 'utf8')
  const seed = JSON.parse(seedRaw)
  if (hasSensitiveAIConfig(seed)) {
    throw new Error('Packaged ai-settings.seed.json still contains API credentials')
  }

  const files = collectFiles(resourcesDir)
  const violations = files.filter((file) =>
    FORBIDDEN_RESOURCE_SEGMENTS.some((segment) => file.includes(segment))
  )

  if (violations.length > 0) {
    throw new Error(`Forbidden runtime artifacts found in bundle:\n${violations.join('\n')}`)
  }

  return {
    resourcesDir,
    checkedFiles: files.length,
    aiSeedPath: join(resourcesDir, 'ai-settings.seed.json'),
  }
}

function writeManifest(verification) {
  const artifacts = existsSync(exportsDir)
    ? readdirSync(exportsDir).sort()
    : []

  const manifest = {
    createdAt: new Date().toISOString(),
    projectRoot,
    outputDir: exportsDir,
    mode: dirOnly ? 'dir-only' : 'dist',
    artifacts,
    sanitized: {
      aiSeed: 'empty-object',
      strippedPythonCaches: Array.from(SKIP_DIR_NAMES),
      strippedPythonBytecode: SKIP_FILE_SUFFIXES,
      forbiddenRuntimeSegments: FORBIDDEN_RESOURCE_SEGMENTS,
    },
    verification,
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function getElectronBuilderBin() {
  return process.platform === 'win32'
    ? join(projectRoot, 'node_modules', '.bin', 'electron-builder.cmd')
    : join(projectRoot, 'node_modules', '.bin', 'electron-builder')
}

function main() {
  logStep('prepare', 'clean staging')
  cleanDir(stagingRoot)
  ensureDir(stagingRoot)

  if (!skipCleanExports) {
    logStep('prepare', 'clean previous exports')
    removeOldExports()
  }

  logStep('sanitize', 'write empty ai-settings seed')
  createCleanSeed()

  logStep('sanitize', 'copy sidecar without caches')
  prepareSanitizedPython()

  logStep('sanitize', 'copy embedded skills without caches')
  prepareSanitizedEmbeddedSkills()

  logStep('sanitize', 'generate clean electron-builder config')
  buildCleanBuilderConfig()

  logStep('build', 'npm run build')
  runCommand('npm', ['run', 'build'])

  const electronBuilderBin = getElectronBuilderBin()
  const builderArgs = ['--config', tempBuilderConfigPath, '--publish', 'never']
  if (dirOnly) builderArgs.push('--dir')

  logStep('build', `electron-builder ${builderArgs.join(' ')}`)
  runCommand(electronBuilderBin, builderArgs)

  logStep('cleanup', 'remove builder debug helpers')
  removeGeneratedDebugFiles()

  logStep('verify', 'inspect packaged resources')
  const verification = verifyPackagedResources()
  writeManifest(verification)

  if (!keepStaging) {
    logStep('cleanup', 'remove staging')
    cleanDir(stagingRoot)
  }

  logStep('done', `artifacts updated in ${exportsDir}`)
  process.stdout.write(`[packer] manifest: ${manifestPath}\n`)
}

try {
  main()
} catch (error) {
  console.error('[packer] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
