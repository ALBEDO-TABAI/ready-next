#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { basename, delimiter, join, relative, resolve, sep } from 'node:path'
import YAML from 'yaml'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const packerRoot = fileURLToPath(new URL('./', import.meta.url))
const stagingRoot = join(packerRoot, '.staging', 'clean-package')
const exportsDir = join(projectRoot, 'exports')
const cleanSeedPath = join(stagingRoot, 'build', 'runtime-seeds', 'ai-settings.seed.json')
const cleanPythonRoot = join(stagingRoot, 'src', 'python')
const cleanEmbeddedSkillsRoot = join(stagingRoot, 'assets', 'embedded-skills')
const cleanPackagedRuntimeRoot = join(stagingRoot, 'release-runtime', 'skill-runtime')
const builderConfigPath = join(projectRoot, 'electron-builder.yml')
const tempBuilderConfigPath = join(stagingRoot, 'electron-builder.clean.yml')
const manifestPath = join(exportsDir, 'clean-package-manifest.json')

const argv = new Set(process.argv.slice(2))
const dirOnly = argv.has('--dir-only')
const skipCleanExports = argv.has('--skip-clean-exports')
const keepStaging = argv.has('--keep-staging')
const allowNetworkRuntime = argv.has('--allow-network-runtime')
const releaseRuntimeSource = String(process.env.READY_RELEASE_SKILL_RUNTIME_ROOT || '').trim()

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
  'rss-artifacts',
  'rsshub-runtime',
  'puppeteer-cache',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
]

const PACKAGED_RUNTIME_MANIFEST = 'runtime-manifest.json'
const REQUIRED_RUNTIME_SKILLS = [
  'video-expert-analyzer',
  'video-copy-analyzer',
  'lets-go-rss',
  'deep-research',
  'systematic-literature-review',
  'github-deep-research',
  'academic-paper-review',
  'web-design-guidelines',
  'find-skills',
  'obsidian-web-clip',
  'study-notes',
  'image-analysis-router',
  'image-reverse-descriptor',
  'fastnote',
]
const REQUIRED_RUNTIME_TOOLS = ['ffmpeg', 'ffprobe', 'yt-dlp']
const REQUIRED_RUNTIME_MODULES = [
  'anthropic',
  'apscheduler',
  'browser_cookie3',
  'cv2',
  'dateutil',
  'dotenv',
  'fastapi',
  'ffmpeg',
  'funasr',
  'httpx',
  'lark_oapi',
  'modelscope',
  'numpy',
  'openai',
  'PIL',
  'pydantic',
  'pysrt',
  'reportlab',
  'requests',
  'scenedetect',
  'torch',
  'torchaudio',
  'uvicorn',
  'yt_dlp',
  'rapidocr_onnxruntime',
]
const REQUIRED_RUNTIME_ASR_MODELS = [
  {
    name: 'FunASR Nano',
    kwargs: {
      model: 'FunAudioLLM/Fun-ASR-Nano-2512',
      disable_update: true,
    },
  },
  {
    name: 'FunASR paraformer fallback',
    kwargs: {
      model: 'paraformer-zh',
      vad_model: 'fsmn-vad',
      punc_model: 'ct-punc',
      disable_update: true,
    },
  },
]
const RUNTIME_SKIP_DIR_NAMES = new Set([
  ...SKIP_DIR_NAMES,
  'skills',
  'custom-skills',
  'outputs',
  'results',
  '.ready',
])
const RUNTIME_SKIP_RELATIVE_PREFIXES = [
  `cache${sep}pip`,
  `cache${sep}whisper`,
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
  copyFileSync(src, dst)
  chmodSync(dst, stat.mode)
}

function copyReleaseRuntimeTree(src, dst, root = src) {
  const stat = lstatSync(src)
  const name = basename(src)
  const rel = relative(root, src)

  if (stat.isSymbolicLink()) {
    const resolved = realpathSync(src)
    const resolvedRoot = realpathSync(root)
    if (!resolved.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`Release runtime contains external symlink: ${src} -> ${resolved}`)
    }
  }

  if (stat.isDirectory()) {
    if (RUNTIME_SKIP_DIR_NAMES.has(name)) return
    if (RUNTIME_SKIP_RELATIVE_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}${sep}`))) return
    ensureDir(dst)
    chmodSync(dst, stat.mode)
    for (const child of readdirSync(src)) {
      copyReleaseRuntimeTree(join(src, child), join(dst, child), root)
    }
    return
  }

  if (SKIP_FILE_NAMES.has(name)) return
  if (SKIP_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return

  ensureDir(resolve(dst, '..'))
  copyFileSync(src, dst)
  chmodSync(dst, stat.mode)
}

function readShebang(file) {
  const header = Buffer.alloc(512)
  let bytesRead = 0
  const fd = openSync(file, 'r')
  try {
    bytesRead = readSync(fd, header, 0, header.length, 0)
  } finally {
    closeSync(fd)
  }
  if (bytesRead < 2 || header[0] !== 0x23 || header[1] !== 0x21) return null
  const activeHeader = header.subarray(0, bytesRead)
  const newlineIndex = activeHeader.indexOf(0x0a)
  const endIndex = newlineIndex === -1 ? bytesRead : newlineIndex
  const line = activeHeader.subarray(0, endIndex).toString('utf8')
  const content = readFileSync(file)
  const contentNewlineIndex = content.indexOf(0x0a)
  return {
    content,
    line,
    rest: contentNewlineIndex === -1 ? Buffer.from('\n') : content.subarray(contentNewlineIndex),
  }
}

function collectRuntimeLauncherFiles(runtimeRoot) {
  return [join(runtimeRoot, 'bin'), runtimePythonBinDir(runtimeRoot)]
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => collectFiles(dir))
}

function rewriteRuntimePythonShebangs(runtimeRoot) {
  if (process.platform === 'win32') return []
  const rewritten = []
  for (const file of collectRuntimeLauncherFiles(runtimeRoot)) {
    const stat = lstatSync(file)
    if (!stat.isFile()) continue
    const shebang = readShebang(file)
    if (!shebang || !/python/i.test(shebang.line)) continue
    const replacement = '#!/usr/bin/env python3'
    if (shebang.line === replacement) continue
    writeFileSync(file, Buffer.concat([Buffer.from(replacement, 'utf8'), shebang.rest]))
    chmodSync(file, stat.mode)
    rewritten.push(relative(runtimeRoot, file).split(sep).join('/'))
  }
  return rewritten
}

function assertRuntimePythonShebangsAreRelocatable(runtimeRoot) {
  if (process.platform === 'win32') return
  for (const file of collectRuntimeLauncherFiles(runtimeRoot)) {
    const stat = lstatSync(file)
    if (!stat.isFile()) continue
    const shebang = readShebang(file)
    if (!shebang || !/python/i.test(shebang.line)) continue
    if (!/^#!\/usr\/bin\/env\s+python3(?:\s|$)/u.test(shebang.line)) {
      throw new Error(`Packaged runtime Python launcher is not relocatable: ${file} (${shebang.line})`)
    }
  }
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

  if (!allowNetworkRuntime) {
    parsed.extraResources.push({
      from: toPosixRelative(cleanPackagedRuntimeRoot),
      to: 'skill-runtime',
      filter: ['**/*'],
    })
  }

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

function preparePackagedRuntime() {
  if (allowNetworkRuntime) return null
  if (!releaseRuntimeSource) {
    throw new Error('READY_RELEASE_SKILL_RUNTIME_ROOT is required for release packaging. Pass --allow-network-runtime only for non-release developer builds.')
  }
  if (!existsSync(releaseRuntimeSource)) {
    throw new Error(`READY_RELEASE_SKILL_RUNTIME_ROOT does not exist: ${releaseRuntimeSource}`)
  }
  verifyRuntimeSource(releaseRuntimeSource)
  copyReleaseRuntimeTree(releaseRuntimeSource, cleanPackagedRuntimeRoot)
  const rewrittenPythonLaunchers = rewriteRuntimePythonShebangs(cleanPackagedRuntimeRoot)
  assertRuntimePythonShebangsAreRelocatable(cleanPackagedRuntimeRoot)
  verifyRuntimeSource(cleanPackagedRuntimeRoot)
  return {
    source: releaseRuntimeSource,
    staged: cleanPackagedRuntimeRoot,
    rewrittenPythonLaunchers,
  }
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

function readRuntimeManifest(runtimeRoot) {
  const manifestPath = join(runtimeRoot, PACKAGED_RUNTIME_MANIFEST)
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing packaged runtime manifest: ${manifestPath}`)
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

function verifyRuntimeManifest(runtimeRoot) {
  const manifest = readRuntimeManifest(runtimeRoot)
  const skills = Array.isArray(manifest.embeddedSkillIds) ? manifest.embeddedSkillIds : []
  const tools = Array.isArray(manifest.tools) ? manifest.tools : []
  const modules = Array.isArray(manifest.pythonModules) ? manifest.pythonModules : []

  for (const skill of REQUIRED_RUNTIME_SKILLS) {
    if (!skills.includes(skill)) throw new Error(`Packaged runtime manifest does not cover embedded skill: ${skill}`)
  }
  for (const tool of REQUIRED_RUNTIME_TOOLS) {
    if (!tools.includes(tool)) throw new Error(`Packaged runtime manifest does not declare tool: ${tool}`)
  }
  for (const moduleName of REQUIRED_RUNTIME_MODULES) {
    if (!modules.includes(moduleName)) throw new Error(`Packaged runtime manifest does not declare Python module: ${moduleName}`)
  }
  return manifest
}

function runtimePythonPath(runtimeRoot) {
  return process.platform === 'win32'
    ? join(runtimeRoot, 'python', 'Scripts', 'python.exe')
    : join(runtimeRoot, 'python', 'bin', 'python3')
}

function runtimeToolCandidates(runtimeRoot, tool) {
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']
  return [
    ...suffixes.map((suffix) => join(runtimeRoot, 'bin', `${tool}${suffix}`)),
    ...suffixes.map((suffix) => join(runtimeRoot, 'python', process.platform === 'win32' ? 'Scripts' : 'bin', `${tool}${suffix}`)),
  ]
}

function verifyRuntimeTool(runtimeRoot, tool) {
  const candidates = runtimeToolCandidates(runtimeRoot, tool)
  const failures = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const result = spawnSync(candidate, ['--version'], {
      cwd: runtimeRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: buildRuntimeProbeEnv(runtimeRoot),
    })
    if (result.status === 0) return candidate
    failures.push(`${candidate}: ${result.error?.message || collectProbeOutput(result) || `exit ${result.status}`}`)
  }
  throw new Error(`Packaged runtime tool ${tool} is missing or not runnable:\n${failures.length > 0 ? failures.join('\n') : `checked ${candidates.join(', ')}`}`)
}

function parsePythonVersionText(value) {
  const match = String(value || '').match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  }
}

function isSupportedReadyPythonVersion(version) {
  return Boolean(version)
    && version.major === 3
    && version.minor >= 9
    && version.minor <= 12
}

function parseOpenSslVersionText(value) {
  const match = String(value || '').match(/OpenSSL\s+(\d+)\.(\d+)\.(\d+)/i)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function isSupportedReadyPythonSslVersion(value) {
  const version = parseOpenSslVersionText(value || '')
  if (!version) return false
  if (version.major > 1) return true
  if (version.major < 1) return false
  if (version.minor > 1) return true
  if (version.minor < 1) return false
  return version.patch >= 1
}

function runtimePythonBinDir(runtimeRoot) {
  return join(runtimeRoot, 'python', process.platform === 'win32' ? 'Scripts' : 'bin')
}

function buildRuntimeProbeEnv(runtimeRoot) {
  const env = { ...process.env }
  for (const key of [
    'PYTHONHOME',
    'PYTHONPATH',
    'PYTHONUSERBASE',
    'VIRTUAL_ENV',
    'CONDA_DEFAULT_ENV',
    'CONDA_PREFIX',
  ]) {
    delete env[key]
  }
  return {
    ...env,
    PATH: [join(runtimeRoot, 'bin'), runtimePythonBinDir(runtimeRoot), env.PATH || ''].join(delimiter),
    XDG_CACHE_HOME: join(runtimeRoot, 'cache'),
    MODELSCOPE_CACHE: join(runtimeRoot, 'cache', 'modelscope'),
    HF_HOME: join(runtimeRoot, 'cache', 'huggingface'),
    PIP_NO_INDEX: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    MODELSCOPE_OFFLINE: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  }
}

function collectProbeOutput(result) {
  return `${result.stdout || ''}${result.stderr || ''}`.trim()
}

function verifyPythonRuntimeGate(python, runtimeRoot) {
  const versionResult = spawnSync(python, ['--version'], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: buildRuntimeProbeEnv(runtimeRoot),
  })
  if (versionResult.status !== 0) {
    throw new Error(`Packaged runtime Python version probe failed:\n${collectProbeOutput(versionResult)}`)
  }
  const versionText = collectProbeOutput(versionResult)
  if (!isSupportedReadyPythonVersion(parsePythonVersionText(versionText))) {
    throw new Error(`Packaged runtime Python has unsupported version: ${versionText || 'unknown'}`)
  }

  const sslResult = spawnSync(python, ['-c', 'import ssl; print(ssl.OPENSSL_VERSION)'], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: buildRuntimeProbeEnv(runtimeRoot),
  })
  if (sslResult.status !== 0) {
    throw new Error(`Packaged runtime Python OpenSSL probe failed:\n${collectProbeOutput(sslResult)}`)
  }
  const sslText = collectProbeOutput(sslResult)
  if (!isSupportedReadyPythonSslVersion(sslText)) {
    throw new Error(`Packaged runtime Python has unsupported OpenSSL: ${sslText || 'unknown'}`)
  }
}

function verifyAsrModelCaches(python, runtimeRoot) {
  const modelProbe = [
    'import importlib.util, json, pathlib, sys',
    'import funasr',
    'package_root = pathlib.Path(getattr(funasr, "__file__", "")).resolve().parent',
    'nano_model = package_root / "models" / "fun_asr_nano" / "model.py"',
    'if nano_model.exists():',
    '    nano_dir = str(nano_model.parent)',
    '    if nano_dir not in sys.path:',
    '        sys.path.insert(0, nano_dir)',
    '    spec = importlib.util.spec_from_file_location("_ready_release_funasr_nano_model", nano_model)',
    '    module = importlib.util.module_from_spec(spec)',
    '    sys.modules["_ready_release_funasr_nano_model"] = module',
    '    spec.loader.exec_module(module)',
    'from funasr import AutoModel',
    `models = json.loads(${JSON.stringify(JSON.stringify(REQUIRED_RUNTIME_ASR_MODELS))})`,
    'failures = []',
    'for item in models:',
    '    try:',
    '        AutoModel(**item["kwargs"])',
    '    except Exception as exc:',
    '        failures.append("{}: {}: {}".format(item["name"], type(exc).__name__, exc))',
    'raise SystemExit("\\n".join(failures) if failures else 0)',
  ].join('\n')
  const result = spawnSync(python, ['-c', modelProbe], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    timeout: 600_000,
    env: buildRuntimeProbeEnv(runtimeRoot),
  })
  if (result.status !== 0) {
    throw new Error(`Packaged runtime ASR model cache probe failed:\n${collectProbeOutput(result)}`)
  }
}

function verifyNoEscapingSymlinks(runtimeRoot) {
  const rootReal = realpathSync(runtimeRoot)
  for (const file of collectFiles(runtimeRoot)) {
    const stat = lstatSync(file)
    if (!stat.isSymbolicLink()) continue
    const target = realpathSync(file)
    if (!target.startsWith(`${rootReal}${sep}`)) {
      throw new Error(`Packaged runtime contains external symlink: ${file} -> ${target}`)
    }
  }
}

function verifyRuntimeSource(runtimeRoot) {
  verifyRuntimeManifest(runtimeRoot)
  verifyNoEscapingSymlinks(runtimeRoot)

  const python = runtimePythonPath(runtimeRoot)
  if (!existsSync(python)) throw new Error(`Packaged runtime missing Python: ${python}`)
  verifyPythonRuntimeGate(python, runtimeRoot)
  for (const tool of REQUIRED_RUNTIME_TOOLS) {
    verifyRuntimeTool(runtimeRoot, tool)
  }

  const importProbe = [
    'import importlib.util',
    `mods=${JSON.stringify(REQUIRED_RUNTIME_MODULES)}`,
    'missing=[m for m in mods if importlib.util.find_spec(m) is None]',
    'raise SystemExit("missing modules: "+",".join(missing) if missing else 0)',
  ].join(';')
  const result = spawnSync(python, ['-c', importProbe], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: buildRuntimeProbeEnv(runtimeRoot),
  })
  if (result.status !== 0) {
    throw new Error(`Packaged runtime Python import probe failed:\n${result.stdout || ''}${result.stderr || ''}`)
  }
  verifyAsrModelCaches(python, runtimeRoot)
}

function verifyPackagedRuntime(runtimeRoot) {
  verifyRuntimeSource(runtimeRoot)
  const manifest = readRuntimeManifest(runtimeRoot)
  return {
    mode: 'packaged-runtime',
    runtimeRoot,
    runtimeId: manifest.runtimeId || null,
    skills: manifest.embeddedSkillIds,
    tools: manifest.tools,
  }
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

  const runtime = allowNetworkRuntime
    ? { mode: 'network-runtime-allowed' }
    : verifyPackagedRuntime(join(resourcesDir, 'skill-runtime'))

  return {
    resourcesDir,
    checkedFiles: files.length,
    aiSeedPath: join(resourcesDir, 'ai-settings.seed.json'),
    runtime,
  }
}

function writeManifest(verification, runtime) {
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
      packagedSkillRuntime: runtime,
      allowNetworkRuntime,
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

  logStep('sanitize', allowNetworkRuntime ? 'skip packaged skill runtime (developer mode)' : 'copy packaged skill runtime')
  const runtime = preparePackagedRuntime()

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
  writeManifest(verification, runtime)

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
